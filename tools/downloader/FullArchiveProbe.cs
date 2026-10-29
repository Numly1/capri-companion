using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Web.Script.Serialization;
using CapriReadyDownload;
internal static class FullArchiveProbe {
    static int Main(string[] args) { try {
        DownloaderCore.ConfigurePaths();
        var source=Path.GetFullPath(args[0]); var destination=Path.GetFullPath(args[1]);
        if(!destination.StartsWith("D:\\Capri-GitHub-Release\\",StringComparison.OrdinalIgnoreCase) || Directory.Exists(destination)) throw new Exception("Use a new D-only test destination.");
        var spec=BuildInfo.Bundle;
        if(!DownloaderCore.Verified(source,spec.ArchiveBytes,spec.ArchiveSha,CancellationToken.None)) throw new Exception("Original archive differs.");
        var start=DateTime.UtcNow; Console.WriteLine("{\"stage\":\"extract\",\"verifiedArchive\":true}");
        DownloaderCore.ExtractSafe(source,destination,null,CancellationToken.None);
        var root=Path.Combine(destination,"Капри");
        var serializer=new JavaScriptSerializer { MaxJsonLength=20000000 };
        var manifest=serializer.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(root,"bundle-manifest.json")));
        var entries=(Dictionary<string,object>)manifest["files"];
        var selected=new[] {"Запустить Капри.exe",".tools/capri-qwen-voice/venv/Scripts/python.exe",".tools/capri-qwen-voice/hf-cache/hub/models--Qwen--Qwen3-TTS-12Hz-1.7B-Base/snapshots/fd4b254389122332181a7c3db7f27e918eec64e3/model.safetensors"};
        foreach(var name in selected) {
            var item=(Dictionary<string,object>)entries[name]; var file=Path.Combine(root,name.Replace('/',Path.DirectorySeparatorChar));
            if(!DownloaderCore.Verified(file,Convert.ToInt64(item["bytes"]),(string)item["sha256"],CancellationToken.None)) throw new Exception("Extracted hash differs: "+name);
        }
        long total=0; var files=Directory.GetFiles(root,"*",SearchOption.AllDirectories); foreach(var file in files) total+=new FileInfo(file).Length;
        Console.WriteLine("{\"ok\":true,\"fullArchiveExtracted\":true,\"files\":"+files.Length+",\"bytes\":"+total+",\"selectedHashesVerified\":3,\"seconds\":"+(int)(DateTime.UtcNow-start).TotalSeconds+"}");
        return 0;
    } catch(Exception e) { Console.Error.WriteLine(e.ToString()); return 1; } }
}
