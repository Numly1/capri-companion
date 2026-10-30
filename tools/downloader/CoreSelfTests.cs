#if TEST_BUILD
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace CapriReadyDownload {
    internal sealed class FixtureServer : IDisposable {
        readonly TcpListener listener; readonly Dictionary<string,byte[]> files; volatile bool stopped;
        public int Requests; public int DelayMilliseconds;
        public Uri BaseUri;
        public FixtureServer(Dictionary<string,byte[]> payloads) {
            files=payloads; listener=new TcpListener(IPAddress.Loopback,0); listener.Start();
            BaseUri=new Uri("http://127.0.0.1:"+((IPEndPoint)listener.LocalEndpoint).Port+"/");
            Task.Run(async delegate { while(!stopped) { try { var client=await listener.AcceptTcpClientAsync(); Task.Run(delegate { Serve(client); }); } catch { if(stopped) break; } } });
        }
        void Serve(TcpClient client) {
            try { using(client) using(var stream=client.GetStream()) using(var reader=new StreamReader(stream,Encoding.ASCII,false,4096,true)) {
                var request=reader.ReadLine(); if(request==null) return;
                for(int i=0;i<40;i++) { var header=reader.ReadLine(); if(String.IsNullOrEmpty(header)) break; }
                var name=Uri.UnescapeDataString(request.Split(' ')[1].TrimStart('/')); byte[] payload;
                if(!files.TryGetValue(name,out payload)) payload=new byte[0]; Interlocked.Increment(ref Requests);
                var headers=Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: "+payload.Length+"\r\n\r\n");
                stream.Write(headers,0,headers.Length); stream.Flush();
                if(DelayMilliseconds>0) Thread.Sleep(DelayMilliseconds);
                stream.Write(payload,0,payload.Length); stream.Flush();
            }} catch { }
        }
        public void Dispose() { stopped=true; listener.Stop(); }
    }
    internal static class CoreSelfTests {
        static int checks;
        static void Check(bool condition,string label) { if(!condition) throw new Exception(label); checks++; }
        static async Task ExpectFailure(Func<Task> action,string label) { bool failed=false; try { await action(); } catch { failed=true; } Check(failed,label); }
        static void ExpectFailure(Action action,string label) { bool failed=false; try { action(); } catch { failed=true; } Check(failed,label); }
        static string Root;
        static async Task Run() {
            Root=Path.Combine(Path.GetTempPath(),"Capri downloader tests "+Guid.NewGuid().ToString("N")); Directory.CreateDirectory(Root);
            var zip=Path.Combine(Root,"fixture.zip"); var launcher=Encoding.UTF8.GetBytes("TEST FIXTURE ONLY — never execute");
            using(var archive=ZipFile.Open(zip,ZipArchiveMode.Create)) {
                using(var output=archive.CreateEntry("Капри/Запустить Капри.exe").Open()) output.Write(launcher,0,launcher.Length);
                using(var output=archive.CreateEntry("Капри/data.txt").Open()) { var payload=Encoding.UTF8.GetBytes(new String('Ж',2000)); output.Write(payload,0,payload.Length); }
                using(var output=archive.CreateEntry("Капри/bundle-manifest.json").Open()) { var payload=Encoding.UTF8.GetBytes("{\"version\":\"old\",\"entryPoint\":\"Запустить Капри.exe\",\"files\":{\"Запустить Капри.exe\":{\"bytes\":0,\"sha256\":\"fixture\"},\"data.txt\":{\"bytes\":4000,\"sha256\":\"unchanged\"}}}"); output.Write(payload,0,payload.Length); }
            }
            var archiveBytes=File.ReadAllBytes(zip); var payloads=new Dictionary<string,byte[]>(); var parts=new List<PartInfo>();
            var launcherFile=Path.Combine(Root,"launcher-fixture.bin"); File.WriteAllBytes(launcherFile,launcher);
            int offset=0;
            for(int i=0;i<3;i++) { int length=i==2?archiveBytes.Length-offset:archiveBytes.Length/3; var payload=new byte[length]; Array.Copy(archiveBytes,offset,payload,0,length); offset+=length;
                var name="fixture.part0"+(i+1); var file=Path.Combine(Root,name); File.WriteAllBytes(file,payload); payloads[name]=payload;
                parts.Add(new PartInfo(name,length,DownloaderCore.Hash(file,CancellationToken.None)));
            }
            using(var server=new FixtureServer(payloads)) {
                var spec=new BundleSpec { BaseUri=server.BaseUri,Parts=parts.ToArray(),ArchiveBytes=archiveBytes.Length,ArchiveSha=DownloaderCore.Hash(zip,CancellationToken.None),LauncherSha=DownloaderCore.Hash(launcherFile,CancellationToken.None),RequiredFreeBytes=1,UnpackedBytes=4050,SafetyBytes=0 };
                var parent=Path.Combine(Root,"Тестовая папка");
                var final=await DownloaderCore.Install(spec,parent,null,CancellationToken.None);
                Check(File.ReadAllText(Path.Combine(final,"data.txt"))==new String('Ж',2000),"download/join/extract retained UTF8 payload");
                Check(server.Requests==3,"one request per part"); Check(DownloaderCore.Installed(final,spec,CancellationToken.None),"installed marker+launcher verified");
                Check(await DownloaderCore.Install(spec,parent,null,CancellationToken.None)==final && server.Requests==3,"repeat launch needs no network");
                var resume=Path.Combine(Root,"Resume folder"); var cache=Path.Combine(resume,".capri-download-"+spec.ArchiveSha.Substring(0,12)); Directory.CreateDirectory(cache);
                File.WriteAllText(Path.Combine(cache,"owner.sha256"),spec.ArchiveSha); File.WriteAllBytes(Path.Combine(cache,parts[0].Name),payloads[parts[0].Name]);
                await DownloaderCore.Install(spec,resume,null,CancellationToken.None); Check(server.Requests==5,"valid cached part is reused");
                var space=new BundleSpec { ArchiveBytes=100,UnpackedBytes=150,RequiredFreeBytes=300,SafetyBytes=20 };
                Check(DownloaderCore.RemainingFreeSpace(space,false,0)==300,"fresh install keeps conservative preflight");
                Check(DownloaderCore.RemainingFreeSpace(space,false,50)==220,"resumed parts do not require initial free space again");
                Check(DownloaderCore.RemainingFreeSpace(space,true,100)==170,"verified ZIP only requires extraction space");
                var existing=Path.Combine(Root,"Existing folder"); var existingFinal=Path.Combine(existing,"Капри"); Directory.CreateDirectory(existingFinal); var privateFile=Path.Combine(existingFinal,"private.txt"); File.WriteAllText(privateFile,"preserve");
                await ExpectFailure(delegate { return DownloaderCore.Install(spec,existing,null,CancellationToken.None); },"existing folder must not be replaced"); Check(File.ReadAllText(privateFile)=="preserve","existing user file preserved");
                var corrupted=Path.Combine(Root,"bad-joined.zip");
                ExpectFailure(delegate { DownloaderCore.JoinParts(new[]{Path.Combine(Root,parts[0].Name)},corrupted,parts[0].Bytes,new String('0',64),CancellationToken.None); },"invalid archive hash rejected");
                var traversal=Path.Combine(Root,"traversal.zip"); using(var a=ZipFile.Open(traversal,ZipArchiveMode.Create)) using(var output=a.CreateEntry("../escape.txt").Open()) output.WriteByte(1);
                ExpectFailure(delegate { DownloaderCore.ExtractSafe(traversal,Path.Combine(Root,"safe-output"),null,CancellationToken.None); },"zip traversal rejected"); Check(!File.Exists(Path.Combine(Root,"escape.txt")),"no file escaped staging");
                var longZip=Path.Combine(Root,"long-path.zip"); var longName="Капри/"+new String('а',150)+"/"+new String('б',150)+".txt";
                using(var a=ZipFile.Open(longZip,ZipArchiveMode.Create)) using(var output=a.CreateEntry(longName).Open()) output.WriteByte(42);
                var longOutput=Path.Combine(Root,"long-output"); DownloaderCore.ExtractSafe(longZip,longOutput,null,CancellationToken.None);
                Check(File.ReadAllBytes(Path.Combine(longOutput,longName.Replace('/',Path.DirectorySeparatorChar)))[0]==42,"long Windows extraction paths supported");
                using(var cancel=new CancellationTokenSource()) { cancel.Cancel(); await ExpectFailure(delegate { return DownloaderCore.Install(spec,Path.Combine(Root,"Cancelled"),null,cancel.Token); },"pre-cancelled setup stops"); }
                server.DelayMilliseconds=1000;
                using(var cancel=new CancellationTokenSource(150)) { await ExpectFailure(delegate { return DownloaderCore.Install(spec,Path.Combine(Root,"Mid download cancel"),null,cancel.Token); },"network read cancellation stops"); Check(cancel.IsCancellationRequested,"download cancellation observed"); }
                Check(!DownloaderCore.AllowedUri(new Uri("https://example.com/payload")),"unknown download host rejected");
                server.DelayMilliseconds=0;
                var updatePayload=Encoding.UTF8.GetBytes("NEW APP TEST FIXTURE ONLY — never execute");
                var updateFile=Path.Combine(Root,"update-fixture.bin"); File.WriteAllBytes(updateFile,updatePayload); payloads["new-app.exe"]=updatePayload;
                var updateSpec=new BundleSpec { BaseUri=spec.BaseUri,Parts=spec.Parts,ArchiveBytes=spec.ArchiveBytes,ArchiveSha=spec.ArchiveSha,LauncherSha=spec.LauncherSha,
                    RequiredFreeBytes=1,UnpackedBytes=4050,SafetyBytes=0,UpdateUri=new Uri(server.BaseUri,"new-app.exe"),UpdateBytes=updatePayload.Length,UpdateSha=DownloaderCore.Hash(updateFile,CancellationToken.None),UpdateVersion="0.4.4-companion.9" };
                int beforeUpdate=server.Requests;
                var latest=await DownloaderCore.Install(updateSpec,Path.Combine(Root,"Fresh latest version"),null,CancellationToken.None);
                Check(server.Requests==beforeUpdate+4,"fresh latest installer reuses base archive specification plus one pinned app download");
                Check(DownloaderCore.Verified(Path.Combine(latest,updateSpec.LauncherName),updatePayload.Length,updateSpec.UpdateSha,CancellationToken.None),"latest application replaced only the fresh staged launcher");
                Check(File.ReadAllText(Path.Combine(latest,"data.txt"))==new String('Ж',2000),"base bundle voice/data files retained during fresh app swap");
                var serializer=new JavaScriptSerializer(); var manifest=serializer.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(latest,"bundle-manifest.json")));
                var entries=(Dictionary<string,object>)manifest["files"]; var row=(Dictionary<string,object>)entries[updateSpec.LauncherName]; var dataRow=(Dictionary<string,object>)entries["data.txt"];
                Check((string)manifest["version"]==updateSpec.UpdateVersion && (string)row["sha256"]==updateSpec.UpdateSha && Convert.ToInt64(row["bytes"])==updatePayload.Length,"fresh updated bundle manifest records version and launcher hash");
                Check((string)dataRow["sha256"]=="unchanged","other manifest entries preserved");
                var receipt=serializer.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(latest,".capri-update.json")));
                Check((string)receipt["format"]=="capri-app-update" && (string)receipt["launcherSha256"]==updateSpec.UpdateSha && (string)receipt["baseArchiveSha256"]==spec.ArchiveSha,"updater-compatible receipt retained");
                Check(DownloaderCore.Installed(latest,updateSpec,CancellationToken.None),"new launcher is accepted as installed");
                int beforeExisting=server.Requests;
                await ExpectFailure(delegate { return DownloaderCore.Install(updateSpec,parent,null,CancellationToken.None); },"existing old installation requests the small updater rather than relaunching old app");
                Check(server.Requests==beforeExisting && File.ReadAllBytes(Path.Combine(final,spec.LauncherName)).Length==launcher.Length,"existing old install was not downloaded or overwritten");
                var badSpec=new BundleSpec { BaseUri=spec.BaseUri,Parts=spec.Parts,ArchiveBytes=spec.ArchiveBytes,ArchiveSha=spec.ArchiveSha,LauncherSha=spec.LauncherSha,
                    RequiredFreeBytes=1,UnpackedBytes=4050,SafetyBytes=0,UpdateUri=updateSpec.UpdateUri,UpdateBytes=updatePayload.Length,UpdateSha=new String('0',64),UpdateVersion=updateSpec.UpdateVersion };
                var rejectedParent=Path.Combine(Root,"Reject mismatched latest app");
                await ExpectFailure(delegate { return DownloaderCore.Install(badSpec,rejectedParent,null,CancellationToken.None); },"pinned new launcher hash mismatch rejected");
                Check(!Directory.Exists(DownloaderCore.FinalDirectory(rejectedParent,badSpec)),"bad latest app never becomes a final installation");
                var rejectedCache=Path.Combine(rejectedParent,".capri-download-"+badSpec.ArchiveSha.Substring(0,12));
                Check(!Directory.Exists(rejectedCache) || Directory.GetDirectories(rejectedCache,"unpack-*").Length==0,"bad latest app is rejected before expanding the base bundle");
                server.Dispose();
                Check(await DownloaderCore.Install(updateSpec,Path.Combine(Root,"Fresh latest version"),null,CancellationToken.None)==latest,"updated installation reopens offline with local server stopped");
            }
            Console.WriteLine("{\"ok\":true,\"checks\":"+checks+",\"localHttpFixture\":true,\"testDirectory\":\""+Root.Replace("\\","\\\\")+"\"}");
        }
        static int Main() { try { DownloaderCore.ConfigurePaths(); Run().GetAwaiter().GetResult(); return 0; } catch(Exception e) { Console.Error.WriteLine(e.ToString()); return 1; } }
    }
}
#endif
