using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace CapriReadyUpdate {
    internal sealed class UpdateSpec {
        public string Version; public long Bytes; public string Sha256;
        public const string Launcher = "Запустить Капри.exe";
    }
    internal static class UpdaterCore {
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 32 * 1024 * 1024 };
        internal static void ConfigurePaths() {
            AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
            AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);
        }
        internal static string Hash(string file) {
            using(var input=File.OpenRead(file)) using(var hash=SHA256.Create())
                return BitConverter.ToString(hash.ComputeHash(input)).Replace("-", "").ToLowerInvariant();
        }
        internal static Dictionary<string,object> ReadJson(string path, int limit) {
            Regular(path); var info=new FileInfo(path);
            if(info.Length>limit) throw new InvalidDataException("Служебный файл Капри слишком большой.");
            return Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(path,Encoding.UTF8));
        }
        internal static void Regular(string file) {
            if(!File.Exists(file) || (File.GetAttributes(file)&FileAttributes.ReparsePoint)!=0)
                throw new IOException("В папке Капри отсутствует обычный служебный файл. Выберите готовую папку Капри с голосом.");
        }
        internal static string ValidateFolder(string folder) {
            if(String.IsNullOrWhiteSpace(folder) || !Path.IsPathRooted(folder)) throw new IOException("Выберите папку Капри.");
            var root=Path.GetFullPath(folder).TrimEnd(Path.DirectorySeparatorChar);
            if(!Directory.Exists(root) || Path.GetPathRoot(root).StartsWith("\\\\") || (File.GetAttributes(root)&FileAttributes.ReparsePoint)!=0)
                throw new IOException("Выберите обычную папку Капри на локальном диске.");
            var marker=ReadJson(Path.Combine(root,"capri-ready.json"),1024);
            if(marker==null || !marker.ContainsKey("format") || Convert.ToString(marker["format"])!="capri-ready-gift" ||
               !marker.ContainsKey("version") || Convert.ToInt32(marker["version"])!=1 ||
               !marker.ContainsKey("voice") || Convert.ToString(marker["voice"])!="capri-sample")
                throw new IOException("Это не готовая папка Капри с голосом. Нужна папка, где находится «Запустить Капри.exe».");
            Regular(Path.Combine(root,UpdateSpec.Launcher));
            using(var input=File.OpenRead(Path.Combine(root,UpdateSpec.Launcher)))
                if(input.ReadByte()!=77 || input.ReadByte()!=90) throw new InvalidDataException("Стартовый файл Капри повреждён.");
            Regular(Path.Combine(root,"voice-backend-qwen","server.py"));
            Regular(Path.Combine(root,".tools","capri-qwen-voice","venv","Scripts","python.exe"));
            return root;
        }
        internal static string DetectFolder(string settings, string executableDirectory, string currentDirectory, string localData) {
            var candidates=new List<string>();
            try {
                if(File.Exists(settings) && new FileInfo(settings).Length<32768) {
                    var saved=File.ReadAllText(settings).Trim();
                    if(Path.IsPathRooted(saved)) { candidates.Add(Path.Combine(saved,"Капри")); candidates.Add(saved); }
                }
            } catch { }
            candidates.Add(executableDirectory); candidates.Add(Path.Combine(executableDirectory,"Капри"));
            candidates.Add(currentDirectory); candidates.Add(Path.Combine(currentDirectory,"Капри"));
            candidates.Add(Path.Combine(localData,"CapriReady","Капри"));
            foreach(var candidate in candidates) { try { return ValidateFolder(candidate); } catch { } }
            return null;
        }
        internal static bool LauncherRunning(string launcher) {
            var expected=Path.GetFullPath(launcher);
            // NSIS ExecWait keeps this exact portable wrapper alive until Electron exits.
            // Compare full paths, never terminate any process, including other Capri installs.
            foreach(var process in Process.GetProcesses()) using(process) {
                try { if(String.Equals(Path.GetFullPath(process.MainModule.FileName),expected,StringComparison.OrdinalIgnoreCase)) return true; }
                catch { /* Other users' and protected processes are irrelevant. */ }
            }
            return false;
        }
        internal static string JsonText(object value) { return Json.Serialize(value); }
        static string PrepareMetadata(string root,UpdateSpec spec) {
            var manifest=Path.Combine(root,"bundle-manifest.json");
            var data=ReadJson(manifest,32*1024*1024);
            if(data==null || !data.ContainsKey("entryPoint") || Convert.ToString(data["entryPoint"])!=UpdateSpec.Launcher || !data.ContainsKey("files"))
                throw new InvalidDataException("Манифест готовой Капри не прошёл проверку. Файлы не изменены.");
            var files=data["files"] as Dictionary<string,object>;
            if(files==null || !files.ContainsKey(UpdateSpec.Launcher)) throw new InvalidDataException("Манифест Капри не содержит стартовый файл.");
            data["version"]=spec.Version;
            files[UpdateSpec.Launcher]=new Dictionary<string,object> { {"bytes",spec.Bytes},{"sha256",spec.Sha256} };
            return JsonText(data);
        }
        static string Temporary(string root,string kind) { return Path.Combine(root,".capri-update-"+kind+"-"+Guid.NewGuid().ToString("N")+".tmp"); }
        static void WriteNew(string path,string text) {
            using(var output=new FileStream(path,FileMode.CreateNew,FileAccess.Write,FileShare.None)) {
                var bytes=new UTF8Encoding(false).GetBytes(text); output.Write(bytes,0,bytes.Length); output.Flush(true);
            }
        }
        static void DeleteOwn(string file) { if(file!=null && File.Exists(file)) File.Delete(file); }
        internal static string Apply(string directory,UpdateSpec spec,Func<Stream> payload,CancellationToken token,Action<string> progress,Func<string,bool> running=null,Action<string> checkpoint=null) {
            if(spec==null || String.IsNullOrWhiteSpace(spec.Version) || spec.Bytes<2 || spec.Bytes>512L*1024*1024 ||
               spec.Sha256==null || !System.Text.RegularExpressions.Regex.IsMatch(spec.Sha256,"^[a-f0-9]{64}$")) throw new InvalidDataException("Некорректные сведения об обновлении.");
            var root=ValidateFolder(directory); var launcher=Path.Combine(root,UpdateSpec.Launcher);
            if((running??LauncherRunning)(launcher)) throw new IOException("Сначала закрой Капри: правой кнопкой по ней → «Выйти». Затем нажми «Обновить».");
            // Exclusive access also catches other software holding this installation open.
            using(var unlocked=new FileStream(launcher,FileMode.Open,FileAccess.ReadWrite,FileShare.None)) { }
            var manifest=Path.Combine(root,"bundle-manifest.json");
            var metadata=PrepareMetadata(root,spec);
            var receipt=Path.Combine(root,".capri-update.json");
            if(File.Exists(receipt)) Regular(receipt);
            var required=spec.Bytes+64L*1024*1024;
            if(new DriveInfo(Path.GetPathRoot(root)).AvailableFreeSpace<required) throw new IOException("Для обновления нужно около "+Math.Ceiling(required/1048576.0)+" МБ свободного места.");
            var stage=Temporary(root,"app"); var metaStage=Temporary(root,"manifest"); var receiptStage=Temporary(root,"receipt");
            var metaBackup=Temporary(root,"manifest-backup"); var receiptBackup=Temporary(root,"receipt-backup");
            var backup=Path.Combine(root,"Запустить Капри.previous.exe");
            if(File.Exists(backup) || Directory.Exists(backup)) backup=Path.Combine(root,"Запустить Капри.previous-"+DateTime.UtcNow.ToString("yyyyMMdd-HHmmss")+"-"+Guid.NewGuid().ToString("N").Substring(0,8)+".exe");
            bool appChanged=false,metaChanged=false,receiptChanged=false,receiptExisted=File.Exists(receipt),committed=false;
            try {
                if(progress!=null) progress("Проверяю и готовлю обновление…");
                using(var input=payload()) using(var output=new FileStream(stage,FileMode.CreateNew,FileAccess.Write,FileShare.None,1024*1024)) {
                    var buffer=new byte[1024*1024]; long total=0; int read;
                    while((read=input.Read(buffer,0,buffer.Length))>0) {
                        token.ThrowIfCancellationRequested(); total+=read; if(total>spec.Bytes) throw new InvalidDataException("Размер обновления не совпал.");
                        output.Write(buffer,0,read);
                    }
                    if(total!=spec.Bytes) throw new InvalidDataException("Обновление содержит неполный файл.");
                    output.Flush(true);
                }
                if(!Hash(stage).Equals(spec.Sha256,StringComparison.Ordinal)) throw new InvalidDataException("Проверка обновления не прошла. Старая Капри сохранена.");
                using(var input=File.OpenRead(stage)) if(input.ReadByte()!=77 || input.ReadByte()!=90) throw new InvalidDataException("Обновление не является приложением Windows.");
                WriteNew(metaStage,metadata);
                WriteNew(receiptStage,JsonText(new Dictionary<string,object> {
                    {"format","capri-app-update"},{"version",spec.Version},{"launcher",UpdateSpec.Launcher},
                    {"bytes",spec.Bytes},{"launcherSha256",spec.Sha256},
                    {"baseArchiveSha256","6d95a7d8dc33965fd24e87d941643398b78491914a329ce14597924a799cb319"},
                    {"updatedUtc",DateTime.UtcNow.ToString("o")}
                }));
                token.ThrowIfCancellationRequested();
                ValidateFolder(root);
                if((running??LauncherRunning)(launcher)) throw new IOException("Капри ещё работает. Закрой её через «Выйти» и повтори обновление.");
                // Cancellation is honored before this short atomic commit; afterwards finish or roll back.
                if(progress!=null) progress("Обновляю приложение. Голос и настройки остаются на месте…");
                if(Hash(launcher)!=spec.Sha256) { File.Replace(stage,launcher,backup); appChanged=true; }
                if(checkpoint!=null) checkpoint("app");
                File.Replace(metaStage,manifest,metaBackup); metaChanged=true;
                if(checkpoint!=null) checkpoint("manifest");
                if(receiptExisted) File.Replace(receiptStage,receipt,receiptBackup); else File.Move(receiptStage,receipt);
                receiptChanged=true;
                if(checkpoint!=null) checkpoint("receipt");
                committed=true;
                if(progress!=null) progress("Готово! Капри обновлена. Голос повторно скачивать не нужно.");
                return launcher;
            } catch(Exception failure) {
                try {
                    if(receiptChanged) { if(receiptExisted) File.Replace(receiptBackup,receipt,null); else File.Delete(receipt); }
                    if(metaChanged) File.Replace(metaBackup,manifest,null);
                    if(appChanged) File.Replace(backup,launcher,null);
                } catch(Exception rollback) { throw new IOException("Обновление прервалось. Предыдущий EXE сохранён рядом в файле «Запустить Капри.previous…exe». Голос и личные настройки не изменены.",new AggregateException(failure,rollback)); }
                throw;
            } finally {
                // Only this call's exact random staging files; no directory or recursive deletion.
                foreach(var file in new[]{stage,metaStage,receiptStage}) { try { DeleteOwn(file); } catch { } }
                if(committed) foreach(var file in new[]{metaBackup,receiptBackup}) { try { DeleteOwn(file); } catch { } }
            }
        }
    }
}
