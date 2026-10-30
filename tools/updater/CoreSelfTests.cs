using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

namespace CapriReadyUpdate {
    internal static class CoreSelfTests {
        static int passed; static string root;
        static readonly byte[] Old=Encoding.UTF8.GetBytes("MZ old Capri fixture"), New=Encoding.UTF8.GetBytes("MZ new Capri fixture version nine");
        static void Check(bool ok,string name) { if(!ok) throw new Exception("FAIL: "+name); passed++; Console.WriteLine("PASS "+name); }
        static void Fails(Action body,string name) { bool failed=false; try { body(); } catch { failed=true; } Check(failed,name); }
        static void Put(string file,byte[] value) { Directory.CreateDirectory(Path.GetDirectoryName(file)); File.WriteAllBytes(file,value); }
        static string Fixture(string name) {
            var folder=Path.Combine(root,name); Directory.CreateDirectory(folder);
            File.WriteAllText(Path.Combine(folder,"capri-ready.json"),"{\"format\":\"capri-ready-gift\",\"version\":1,\"voice\":\"capri-sample\"}");
            Put(Path.Combine(folder,UpdateSpec.Launcher),Old);
            Put(Path.Combine(folder,"voice-backend-qwen","server.py"),Encoding.UTF8.GetBytes("voice module unchanged"));
            Put(Path.Combine(folder,".tools","capri-qwen-voice","venv","Scripts","python.exe"),Encoding.UTF8.GetBytes("python unchanged"));
            Put(Path.Combine(folder,".tools","capri-qwen-voice","model.safetensors"),Encoding.UTF8.GetBytes("fixture voice weights unchanged"));
            Put(Path.Combine(folder,".tools","capri-qwen-voice","voice-cache","personal.wav"),Encoding.UTF8.GetBytes("voice cache unchanged"));
            File.WriteAllText(Path.Combine(folder,"bundle-manifest.json"),UpdaterCore.JsonText(new Dictionary<string,object> {
                {"version","0.4.4-companion.8"},{"entryPoint",UpdateSpec.Launcher},{"files",new Dictionary<string,object> {
                    {UpdateSpec.Launcher,new Dictionary<string,object>{{"bytes",Old.Length},{"sha256","old-sha"}}},
                    {"voice/model.safetensors",new Dictionary<string,object>{{"bytes",28},{"sha256","voice-stays-exact"}}}
                }}
            }));
            File.WriteAllText(Path.Combine(folder,".capri-installed.sha256"),"old archive identity");
            File.WriteAllText(Path.Combine(folder,"personal-note.txt"),"preserve user data");
            return folder;
        }
        static UpdateSpec Spec() {
            var path=Path.Combine(root,"new-payload.exe"); File.WriteAllBytes(path,New);
            return new UpdateSpec { Version="0.4.4-companion.9",Bytes=New.Length,Sha256=UpdaterCore.Hash(path) };
        }
        static string Apply(string folder,UpdateSpec spec=null,CancellationToken token=default(CancellationToken),Func<string,bool> running=null,Action<string> checkpoint=null) {
            return UpdaterCore.Apply(folder,spec??Spec(),delegate{return new MemoryStream(New,false);},token,null,running??delegate{return false;},checkpoint);
        }
        static int Main(string[] args) {
            if(args.Length==1 && args[0]=="--hold") { Thread.Sleep(30000); return 0; }
            UpdaterCore.ConfigurePaths();
            root=Path.Combine(Path.GetTempPath(),"CapriUpdaterTests-"+Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
            try {
                var valid=Fixture("Папка с пробелами"); var oldHash=UpdaterCore.Hash(Path.Combine(valid,UpdateSpec.Launcher));
                var voice=Path.Combine(valid,".tools","capri-qwen-voice","model.safetensors"); var voiceHash=UpdaterCore.Hash(voice);
                var updated=Apply(valid);
                Check(UpdaterCore.Hash(updated)==Spec().Sha256,"application replaced with verified payload");
                Check(UpdaterCore.Hash(Path.Combine(valid,"Запустить Капри.previous.exe"))==oldHash,"old application backup preserved");
                Check(UpdaterCore.Hash(voice)==voiceHash && File.ReadAllText(Path.Combine(valid,"personal-note.txt"))=="preserve user data" && File.ReadAllText(Path.Combine(valid,".capri-installed.sha256"))=="old archive identity","voice user files and base archive identity unchanged");
                var manifest=UpdaterCore.ReadJson(Path.Combine(valid,"bundle-manifest.json"),32*1024*1024);
                var files=(Dictionary<string,object>)manifest["files"];
                Check(Convert.ToString(manifest["version"])==Spec().Version && Convert.ToString(((Dictionary<string,object>)files["voice/model.safetensors"])["sha256"])=="voice-stays-exact","only launcher manifest row and version updated");
                var receipt=UpdaterCore.ReadJson(Path.Combine(valid,".capri-update.json"),8192);
                Check(Convert.ToString(receipt["format"])=="capri-app-update" && Convert.ToString(receipt["launcherSha256"])==Spec().Sha256,"pinned updater receipt written");
                Apply(valid); Check(Directory.GetFiles(valid,"*.previous*.exe").Length==1,"repeating update is idempotent without another backup");
                var bad=Fixture("bad hash"); var badSpec=Spec(); badSpec.Sha256=new string('0',64);
                Fails(delegate{Apply(bad,badSpec);},"corrupt payload rejected"); Check(UpdaterCore.Hash(Path.Combine(bad,UpdateSpec.Launcher))==oldHash,"corruption leaves old application intact");
                var cancelled=Fixture("cancelled"); var cancellation=new CancellationTokenSource(); cancellation.Cancel();
                Fails(delegate{Apply(cancelled,null,cancellation.Token);},"cancellation before commit rejected");
                Check(UpdaterCore.Hash(Path.Combine(cancelled,UpdateSpec.Launcher))==oldHash && Directory.GetFiles(cancelled,".capri-update-*.tmp").Length==0,"cancellation leaves old application and cleans exact temporary files");
                var locked=Fixture("locked"); using(var handle=new FileStream(Path.Combine(locked,UpdateSpec.Launcher),FileMode.Open,FileAccess.Read,FileShare.None)) Fails(delegate{Apply(locked);},"locked application not replaced");
                Check(UpdaterCore.Hash(Path.Combine(locked,UpdateSpec.Launcher))==oldHash,"locked file remains intact");
                var running=Fixture("running"); Fails(delegate{Apply(running,null,default(CancellationToken),delegate{return true;});},"running exact installation blocks update");
                Check(UpdaterCore.Hash(Path.Combine(running,UpdateSpec.Launcher))==oldHash,"running app remains intact");
                foreach(var phase in new[]{"app","manifest","receipt"}) {
                    var rollback=Fixture("rollback "+phase); var before=File.ReadAllText(Path.Combine(rollback,"bundle-manifest.json"));
                    File.WriteAllText(Path.Combine(rollback,".capri-update.json"),"{\"old\":true}");
                    Fails(delegate{Apply(rollback,null,default(CancellationToken),null,delegate(string at){if(at==phase) throw new IOException("injected metadata failure");});},"injected failure after "+phase);
                    Check(UpdaterCore.Hash(Path.Combine(rollback,UpdateSpec.Launcher))==oldHash && File.ReadAllText(Path.Combine(rollback,"bundle-manifest.json"))==before && File.ReadAllText(Path.Combine(rollback,".capri-update.json"))=="{\"old\":true}","transaction rollback restores launcher and metadata after "+phase);
                }
                var backup=Fixture("old backup"); var existingBackup=Path.Combine(backup,"Запустить Капри.previous.exe"); File.WriteAllText(existingBackup,"user existing backup"); Apply(backup);
                Check(File.ReadAllText(existingBackup)=="user existing backup" && Directory.GetFiles(backup,"*.previous*.exe").Length==2,"existing previous backup never overwritten");
                var invalid=Fixture("invalid marker"); File.WriteAllText(Path.Combine(invalid,"capri-ready.json"),"{\"format\":\"random-folder\"}"); Fails(delegate{Apply(invalid);},"unowned directory rejected");
                var missing=Fixture("missing voice"); File.Delete(Path.Combine(missing,"voice-backend-qwen","server.py")); Fails(delegate{Apply(missing);},"incomplete voice install rejected instead of downloading");
                var metadataBad=Fixture("bad manifest"); File.WriteAllText(Path.Combine(metadataBad,"bundle-manifest.json"),"{}"); Fails(delegate{Apply(metadataBad);},"unrecognized manifest rejected before mutation");
                Check(UpdaterCore.Hash(Path.Combine(metadataBad,UpdateSpec.Launcher))==oldHash,"bad manifest preserves application");
                var detectionParent=Path.Combine(root,"saved destination"); var detection=Fixture("saved destination\\Капри"); var settings=Path.Combine(root,"folder.txt"); File.WriteAllText(settings,detectionParent);
                Check(UpdaterCore.DetectFolder(settings,root,root,root)==detection,"saved downloader parent detects installed Capri");
                Check(UpdaterCore.DetectFolder(Path.Combine(root,"none.txt"),valid,root,root)==valid,"updater beside installed launcher detects it");
                var native=Fixture("actual running wrapper"); var nativeLauncher=Path.Combine(native,UpdateSpec.Launcher); File.Copy(System.Reflection.Assembly.GetExecutingAssembly().Location,nativeLauncher,true);
                using(var child=Process.Start(new ProcessStartInfo(nativeLauncher,"--hold"){UseShellExecute=false,CreateNoWindow=true,WorkingDirectory=native})) {
                    try { Thread.Sleep(500); Check(UpdaterCore.LauncherRunning(nativeLauncher),"real exact running wrapper detected"); Check(!UpdaterCore.LauncherRunning(Path.Combine(valid,UpdateSpec.Launcher)),"another installation is not treated as running"); }
                    finally { if(!child.HasExited) child.Kill(); child.WaitForExit(); }
                }
                Console.WriteLine("RESULT "+passed+" passed; fixture directory "+root); return 0;
            } catch(Exception error) { Console.Error.WriteLine(error); Console.Error.WriteLine("Fixtures retained: "+root); return 1; }
        }
    }
}
