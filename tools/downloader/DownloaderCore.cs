using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace CapriReadyDownload {
    internal sealed class PartInfo {
        public string Name; public long Bytes; public string Sha256;
        public PartInfo(string name, long bytes, string sha) { Name=name; Bytes=bytes; Sha256=sha; }
    }
    internal sealed class BundleSpec {
        public Uri BaseUri; public PartInfo[] Parts; public long ArchiveBytes; public string ArchiveSha;
        public string LauncherSha; public string LauncherName="Запустить Капри.exe";
        public Uri UpdateUri; public long UpdateBytes; public string UpdateSha; public string UpdateVersion;
        public string RootName="Капри"; public long RequiredFreeBytes=11L*1024*1024*1024;
        public long UnpackedBytes=5722450647L; public long SafetyBytes=1024L*1024*1024;
    }
    internal sealed class SetupProgress {
        public string Message; public double Fraction;
        public SetupProgress(string message, double fraction) { Message=message; Fraction=Math.Max(0,Math.Min(1,fraction)); }
    }
    internal static class DownloaderCore {
        internal static void ConfigurePaths() {
            AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling",false);
            AppContext.SetSwitch("Switch.System.IO.BlockLongPaths",false);
        }
        internal static bool AllowedUri(Uri uri) {
            if (uri == null || !uri.IsAbsoluteUri || !String.IsNullOrEmpty(uri.UserInfo)) return false;
#if TEST_BUILD
            if (uri.Scheme=="http" && IPAddress.IsLoopback(IPAddress.Parse(uri.Host))) return true;
#endif
            return uri.Scheme=="https" && (uri.Host=="github.com" || uri.Host.EndsWith(".githubusercontent.com",StringComparison.OrdinalIgnoreCase));
        }
        internal static string Hash(string path, CancellationToken token) {
            using (var hash=SHA256.Create()) using(var input=File.OpenRead(path)) {
                var buffer=new byte[1024*1024]; int read;
                while((read=input.Read(buffer,0,buffer.Length))>0) { token.ThrowIfCancellationRequested(); hash.TransformBlock(buffer,0,read,null,0); }
                hash.TransformFinalBlock(new byte[0],0,0);
                return BitConverter.ToString(hash.Hash).Replace("-","").ToLowerInvariant();
            }
        }
        internal static bool Verified(string path,long bytes,string sha,CancellationToken token) {
            return File.Exists(path) && new FileInfo(path).Length==bytes && Hash(path,token).Equals(sha,StringComparison.OrdinalIgnoreCase);
        }
        static void Report(IProgress<SetupProgress> progress,string text,double fraction) { if(progress!=null) progress.Report(new SetupProgress(text,fraction)); }
        internal static string FinalDirectory(string parent,BundleSpec spec) { return Path.Combine(Path.GetFullPath(parent),spec.RootName); }
        internal static bool Installed(string final,BundleSpec spec,CancellationToken token) {
            var marker=Path.Combine(final,".capri-installed.sha256");
            var launcher=Path.Combine(final,spec.LauncherName);
            if(!File.Exists(marker) || File.ReadAllText(marker).Trim()!=spec.ArchiveSha || !File.Exists(launcher)) return false;
            var hash=Hash(launcher,token);
            return hash.Equals(spec.LauncherSha,StringComparison.OrdinalIgnoreCase) ||
                (HasUpdate(spec) && hash.Equals(spec.UpdateSha,StringComparison.OrdinalIgnoreCase));
        }
        static bool HasUpdate(BundleSpec spec) { return spec.UpdateUri!=null && spec.UpdateBytes>0 && !String.IsNullOrEmpty(spec.UpdateSha); }
        static void WriteUpdateReceipt(string prepared,BundleSpec spec) {
            var serializer=new JavaScriptSerializer { MaxJsonLength=32*1024*1024 };
            var manifestPath=Path.Combine(prepared,"bundle-manifest.json");
            if(!File.Exists(manifestPath) || new FileInfo(manifestPath).Length>32*1024*1024) throw new InvalidDataException("Манифест комплекта не прошёл проверку.");
            var manifest=serializer.Deserialize<Dictionary<string,object>>(File.ReadAllText(manifestPath));
            object entryPoint,filesObject;
            if(!manifest.TryGetValue("entryPoint",out entryPoint) || !(entryPoint is string) || (string)entryPoint!=spec.LauncherName || !manifest.TryGetValue("files",out filesObject)) throw new InvalidDataException("Манифест запуска не прошёл проверку.");
            var entries=filesObject as Dictionary<string,object>;
            if(entries==null || !entries.ContainsKey(spec.LauncherName)) throw new InvalidDataException("Манифест запуска не прошёл проверку.");
            manifest["version"]=spec.UpdateVersion;
            entries[spec.LauncherName]=new Dictionary<string,object> { {"bytes",spec.UpdateBytes},{"sha256",spec.UpdateSha} };
            File.WriteAllText(manifestPath,serializer.Serialize(manifest),new UTF8Encoding(false));
            var receipt=new Dictionary<string,object> {
                {"format","capri-app-update"},{"version",spec.UpdateVersion},{"launcher",spec.LauncherName},
                {"bytes",spec.UpdateBytes},{"launcherSha256",spec.UpdateSha},{"baseArchiveSha256",spec.ArchiveSha},{"updatedUtc",DateTime.UtcNow.ToString("o")}
            };
            File.WriteAllText(Path.Combine(prepared,".capri-update.json"),serializer.Serialize(receipt),new UTF8Encoding(false));
        }
        internal static void CheckDestination(string final) {
            if(Directory.Exists(final) || File.Exists(final)) throw new IOException("В выбранной папке уже есть Капри. Её файлы останутся на месте. Выберите другую папку.");
        }
        static void CheckFreeSpace(string parent,long bytes) {
            var root=Path.GetPathRoot(Path.GetFullPath(parent));
            if(root.StartsWith("\\\\")) throw new IOException("Выберите папку на локальном диске компьютера.");
            if(new DriveInfo(root).AvailableFreeSpace<bytes) throw new IOException("Для продолжения нужно примерно "+Math.Ceiling(bytes/(1024.0*1024*1024))+" ГБ свободного места. Выберите папку на другом диске или освободите место.");
        }
        internal static long RemainingFreeSpace(BundleSpec spec,bool archiveReady,long verifiedParts) {
            if(archiveReady) return spec.UnpackedBytes+spec.SafetyBytes;
            if(verifiedParts>0) return spec.ArchiveBytes-verifiedParts+Math.Max(spec.ArchiveBytes,spec.UnpackedBytes)+spec.SafetyBytes;
            return spec.RequiredFreeBytes;
        }
        static async Task<HttpResponseMessage> OpenResponse(HttpClient client,Uri uri,CancellationToken token) {
            for(int redirects=0;redirects<10;redirects++) {
                if(!AllowedUri(uri)) throw new InvalidDataException("Адрес загрузки не прошёл проверку.");
                var response=await client.GetAsync(uri,HttpCompletionOption.ResponseHeadersRead,token).ConfigureAwait(false);
                if((int)response.StatusCode>=300 && (int)response.StatusCode<400 && response.Headers.Location!=null) {
                    var next=new Uri(uri,response.Headers.Location); response.Dispose(); uri=next; continue;
                }
                response.EnsureSuccessStatusCode(); return response;
            }
            throw new HttpRequestException("Сервис загрузки вернул слишком много перенаправлений.");
        }
        static async Task DownloadPart(HttpClient client,Uri uri,string file,PartInfo part,long before,long total,IProgress<SetupProgress> progress,CancellationToken token) {
            using(var idle=CancellationTokenSource.CreateLinkedTokenSource(token)) {
            idle.CancelAfter(TimeSpan.FromSeconds(90));
            try {
            using(var response=await OpenResponse(client,uri,idle.Token).ConfigureAwait(false))
            using(idle.Token.Register(delegate { response.Dispose(); })) {
                idle.CancelAfter(TimeSpan.FromSeconds(90));
                var declared=response.Content.Headers.ContentLength;
                if(declared.HasValue && declared.Value!=part.Bytes) throw new InvalidDataException("Размер загрузки не совпал с ожидаемым.");
                using(var input=await response.Content.ReadAsStreamAsync().ConfigureAwait(false))
                using(var output=new FileStream(file,FileMode.Create,FileAccess.Write,FileShare.None,1024*1024,true)) {
                    var buffer=new byte[128*1024]; long received=0; int read; var last=DateTime.MinValue;
                    while((read=await input.ReadAsync(buffer,0,buffer.Length,idle.Token).ConfigureAwait(false))>0) {
                        token.ThrowIfCancellationRequested(); received+=read;
                        idle.CancelAfter(TimeSpan.FromSeconds(90));
                        if(received>part.Bytes) throw new InvalidDataException("Сервис передал слишком большой файл.");
                        await output.WriteAsync(buffer,0,read,token).ConfigureAwait(false);
                        if((DateTime.UtcNow-last).TotalMilliseconds>=180) {
                            Report(progress,String.Format("Скачиваю Капри: {0:0.00} из {1:0.00} ГБ",(before+received)/1e9,total/1e9),0.65*(before+received)/total); last=DateTime.UtcNow;
                        }
                    }
                    if(received!=part.Bytes) throw new IOException("Загрузка прервалась. Нажмите «Повторить» — готовые части скачаются заново только при ошибке проверки.");
                }
            }
            } catch(Exception error) { if(idle.IsCancellationRequested && !token.IsCancellationRequested) throw new TimeoutException("Сервис загрузки долго не передаёт данные. Нажмите «Повторить».",error); throw; }
            }
        }
        internal static void JoinParts(string[] parts,string destination,long bytes,string sha,CancellationToken token) {
            using(var output=new FileStream(destination,FileMode.Create,FileAccess.Write,FileShare.None,1024*1024)) {
                var buffer=new byte[1024*1024]; long total=0;
                foreach(var file in parts) using(var input=File.OpenRead(file)) {
                    int read; while((read=input.Read(buffer,0,buffer.Length))>0) { token.ThrowIfCancellationRequested(); total+=read; if(total>bytes) throw new InvalidDataException("Размер архива не совпал."); output.Write(buffer,0,read); }
                }
                if(total!=bytes) throw new InvalidDataException("Архив загрузился не полностью.");
            }
            if(!Verified(destination,bytes,sha,token)) throw new InvalidDataException("Проверка архива не прошла. Файл не будет запущен.");
        }
        internal static void ExtractSafe(string zip,string directory,IProgress<SetupProgress> progress,CancellationToken token) {
            var root=Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar)+Path.DirectorySeparatorChar;
            Directory.CreateDirectory(root);
            using(var archive=ZipFile.OpenRead(zip)) {
                long total=0,completed=0; foreach(var entry in archive.Entries) total+=entry.Length;
                var buffer=new byte[1024*1024]; var last=DateTime.MinValue;
                foreach(var entry in archive.Entries) {
                    token.ThrowIfCancellationRequested();
                    if(Path.IsPathRooted(entry.FullName) || entry.FullName.IndexOf(':')>=0) throw new InvalidDataException("В архиве найден недопустимый путь.");
                    var target=Path.GetFullPath(Path.Combine(root,entry.FullName.Replace('/',Path.DirectorySeparatorChar)));
                    if(!target.StartsWith(root,StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("В архиве найден путь за пределами папки Капри.");
                    if(String.IsNullOrEmpty(entry.Name)) { Directory.CreateDirectory(target); continue; }
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    using(var input=entry.Open()) using(var output=new FileStream(target,FileMode.CreateNew,FileAccess.Write,FileShare.None,1024*1024)) {
                        int read; long actual=0;
                        while((read=input.Read(buffer,0,buffer.Length))>0) { token.ThrowIfCancellationRequested(); actual+=read; if(actual>entry.Length) throw new InvalidDataException("Повреждённый файл в архиве."); output.Write(buffer,0,read); completed+=read;
                            if((DateTime.UtcNow-last).TotalMilliseconds>=180) { Report(progress,"Распаковываю готовую Капри…",0.8+0.2*completed/Math.Max(1,total)); last=DateTime.UtcNow; }
                        }
                        if(actual!=entry.Length) throw new InvalidDataException("В архиве найден неполный файл.");
                    }
                }
            }
        }
        internal static async Task<string> Install(BundleSpec spec,string parent,IProgress<SetupProgress> progress,CancellationToken token) {
            if(!AllowedUri(spec.BaseUri)) throw new InvalidDataException("Адрес загрузки не прошёл проверку.");
            if((spec.UpdateUri!=null || spec.UpdateBytes!=0 || spec.UpdateSha!=null) && (!HasUpdate(spec) || !AllowedUri(spec.UpdateUri) || spec.UpdateSha.Length!=64 || String.IsNullOrEmpty(spec.UpdateVersion))) throw new InvalidDataException("Обновление не прошло проверку параметров.");
            var final=FinalDirectory(parent,spec);
            if(await Task.Run(delegate { return Installed(final,spec,token); },token).ConfigureAwait(false)) {
                if(HasUpdate(spec) && !Verified(Path.Combine(final,spec.LauncherName),spec.UpdateBytes,spec.UpdateSha,token))
                    throw new IOException("Капри уже установлена. Для обновления скачай Capri-Update.exe из нового выпуска. Голос останется на месте — качать его снова не нужно.");
                return final;
            }
            CheckDestination(final);
            var cache=Path.Combine(parent,".capri-download-"+spec.ArchiveSha.Substring(0,12));
            var owner=Path.Combine(cache,"owner.sha256");
            if(Directory.Exists(cache) && (!File.Exists(owner) || File.ReadAllText(owner).Trim()!=spec.ArchiveSha)) throw new IOException("Папка загрузки уже занята. Выберите другую папку.");
            var zip=Path.Combine(cache,"capri-ready.zip");
            bool archiveReady=await Task.Run(delegate { return Verified(zip,spec.ArchiveBytes,spec.ArchiveSha,token); },token).ConfigureAwait(false);
            var readyParts=new HashSet<string>(StringComparer.OrdinalIgnoreCase); long cachedBytes=0;
            foreach(var part in spec.Parts) {
                if(Path.GetFileName(part.Name)!=part.Name) throw new InvalidDataException("Недопустимое имя части архива.");
                var existing=Path.Combine(cache,part.Name);
                Report(progress,"Проверяю уже скачанные файлы…",0);
                if(await Task.Run(delegate { return Verified(existing,part.Bytes,part.Sha256,token); },token).ConfigureAwait(false)) {
                    readyParts.Add(part.Name); cachedBytes+=part.Bytes;
                    if(archiveReady) File.Delete(existing); // Verified duplicates of the verified whole ZIP.
                }
                var partial=existing+".partial";
                if(File.Exists(partial)) using(var incomplete=new FileStream(partial,FileMode.Open,FileAccess.Write,FileShare.None)) incomplete.SetLength(0); // Only our incomplete cache download.
            }
            CheckFreeSpace(parent,RemainingFreeSpace(spec,archiveReady,cachedBytes));
            Directory.CreateDirectory(cache); File.WriteAllText(owner,spec.ArchiveSha);
            if(!archiveReady) {
                var paths=new List<string>(); long before=0;
                using(var handler=new HttpClientHandler { AllowAutoRedirect=false, AutomaticDecompression=DecompressionMethods.None })
                using(var client=new HttpClient(handler)) {
                    client.Timeout=Timeout.InfiniteTimeSpan; client.DefaultRequestHeaders.UserAgent.ParseAdd("CapriReadyDownloader/1.0");
                    foreach(var part in spec.Parts) {
                        token.ThrowIfCancellationRequested();
                        var path=Path.Combine(cache,part.Name); paths.Add(path);
                        Report(progress,"Проверяю уже скачанные файлы…",0.65*before/spec.ArchiveBytes);
                        bool ready=readyParts.Contains(part.Name);
                        if(!ready) {
                            var partial=path+".partial";
                            await DownloadPart(client,new Uri(spec.BaseUri,Uri.EscapeDataString(part.Name)),partial,part,before,spec.ArchiveBytes,progress,token).ConfigureAwait(false);
                            Report(progress,"Проверяю скачанную часть…",0.65*(before+part.Bytes)/spec.ArchiveBytes);
                            if(!await Task.Run(delegate { return Verified(partial,part.Bytes,part.Sha256,token); },token).ConfigureAwait(false)) throw new InvalidDataException("Скачанная часть не прошла проверку. Нажмите «Повторить».");
                            if(File.Exists(path)) File.Move(path,path+".invalid-"+Guid.NewGuid().ToString("N")); // Preserve an unexpectedly changed cache file.
                            File.Move(partial,path);
                        }
                        before+=part.Bytes;
                    }
                }
                Report(progress,"Собираю и проверяю архив…",0.72);
                await Task.Run(delegate { JoinParts(paths.ToArray(),zip,spec.ArchiveBytes,spec.ArchiveSha,token); },token).ConfigureAwait(false);
                foreach(var path in paths) File.Delete(path); // Verified ZIP now replaces its own downloaded parts.
            }
            token.ThrowIfCancellationRequested();
            string update=null;
            // Fetch every required file before expanding the multi-gigabyte bundle. A failed
            // application download must not leave another full extracted copy on each retry.
            if(HasUpdate(spec)) {
                update=Path.Combine(cache,"launcher-update-"+spec.UpdateSha.Substring(0,12)+".exe");
                if(!await Task.Run(delegate { return Verified(update,spec.UpdateBytes,spec.UpdateSha,token); },token).ConfigureAwait(false)) {
                    var partial=update+".partial";
                    Report(progress,"Скачиваю последнюю версию приложения…",0.77);
                    using(var handler=new HttpClientHandler { AllowAutoRedirect=false, AutomaticDecompression=DecompressionMethods.None })
                    using(var client=new HttpClient(handler)) {
                        client.Timeout=Timeout.InfiniteTimeSpan; client.DefaultRequestHeaders.UserAgent.ParseAdd("CapriReadyDownloader/1.1");
                        await DownloadPart(client,spec.UpdateUri,partial,new PartInfo("launcher",spec.UpdateBytes,spec.UpdateSha),0,spec.UpdateBytes,null,token).ConfigureAwait(false);
                    }
                    if(!await Task.Run(delegate { return Verified(partial,spec.UpdateBytes,spec.UpdateSha,token); },token).ConfigureAwait(false)) throw new InvalidDataException("Обновление не прошло проверку. Файл не будет запущен.");
                    if(File.Exists(update)) File.Move(update,update+".invalid-"+Guid.NewGuid().ToString("N"));
                    File.Move(partial,update);
                }
            }
            token.ThrowIfCancellationRequested();
            var unpack=Path.Combine(cache,"unpack-"+Guid.NewGuid().ToString("N"));
            await Task.Run(delegate { ExtractSafe(zip,unpack,progress,token); },token).ConfigureAwait(false);
            var prepared=Path.Combine(unpack,spec.RootName); var launcher=Path.Combine(prepared,spec.LauncherName);
            if(!File.Exists(launcher) || !Hash(launcher,token).Equals(spec.LauncherSha,StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Проверка запуска Капри не прошла.");
            if(HasUpdate(spec)) {
                token.ThrowIfCancellationRequested();
                File.Copy(update,launcher,true); // Only this new staging folder; an existing installation is never overwritten.
                if(!Verified(launcher,spec.UpdateBytes,spec.UpdateSha,token)) throw new InvalidDataException("Проверка новой Капри не прошла.");
                WriteUpdateReceipt(prepared,spec);
            }
            token.ThrowIfCancellationRequested();
            File.WriteAllText(Path.Combine(prepared,".capri-installed.sha256"),spec.ArchiveSha);
            CheckDestination(final); Directory.Move(prepared,final);
            // Remove only the downloaded archive we verified and created; no recursive deletion.
            File.Delete(zip); Report(progress,"Готово! Запускаю Капри…",1); return final;
        }
    }
}
