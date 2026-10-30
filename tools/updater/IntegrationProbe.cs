using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

namespace CapriReadyUpdate {
    internal static class IntegrationProbe {
        static int Main(string[] args) {
            try {
                if(args.Length!=4) throw new ArgumentException("Expected updater.exe, original app.exe, real bundle-manifest.json and new empty probe folder.");
                UpdaterCore.ConfigurePaths();
                var root=Path.GetFullPath(args[3]);
                if(Directory.Exists(root) || File.Exists(root)) throw new IOException("Probe directory must not already exist.");
                var assembly=Assembly.LoadFile(Path.GetFullPath(args[0]));
                var compiled=assembly.GetType("CapriReadyUpdate.BuildInfo",true).GetField("Spec",BindingFlags.NonPublic|BindingFlags.Static).GetValue(null);
                var type=compiled.GetType();
                var spec=new UpdateSpec {Version=(string)type.GetField("Version").GetValue(compiled),Bytes=(long)type.GetField("Bytes").GetValue(compiled),Sha256=(string)type.GetField("Sha256").GetValue(compiled)};
                if(spec.Bytes!=new FileInfo(args[1]).Length || spec.Sha256!=UpdaterCore.Hash(args[1])) throw new InvalidDataException("Embedded build info differs from exact application.");
                Directory.CreateDirectory(root);
                File.WriteAllText(Path.Combine(root,"capri-ready.json"),"{\"format\":\"capri-ready-gift\",\"version\":1,\"voice\":\"capri-sample\"}");
                File.WriteAllBytes(Path.Combine(root,UpdateSpec.Launcher),Encoding.UTF8.GetBytes("MZ old app fixture"));
                var module=Path.Combine(root,"voice-backend-qwen"); Directory.CreateDirectory(module); File.WriteAllText(Path.Combine(module,"server.py"),"module fixture preserve");
                var python=Path.Combine(root,".tools","capri-qwen-voice","venv","Scripts"); Directory.CreateDirectory(python); File.WriteAllText(Path.Combine(python,"python.exe"),"python fixture preserve");
                File.Copy(args[2],Path.Combine(root,"bundle-manifest.json"));
                File.WriteAllText(Path.Combine(root,".capri-installed.sha256"),"6d95a7d8dc33965fd24e87d941643398b78491914a329ce14597924a799cb319");
                var filesBefore=Directory.GetFiles(root,"*",SearchOption.AllDirectories).Length;
                var launcher=UpdaterCore.Apply(root,spec,delegate{return assembly.GetManifestResourceStream("Capri.Application.exe");},CancellationToken.None,Console.WriteLine);
                if(UpdaterCore.Hash(launcher)!=spec.Sha256) throw new InvalidDataException("Final launcher differs.");
                var manifest=UpdaterCore.ReadJson(Path.Combine(root,"bundle-manifest.json"),32*1024*1024);
                var original=UpdaterCore.ReadJson(args[2],32*1024*1024);
                var files=(Dictionary<string,object>)manifest["files"]; var originalFiles=(Dictionary<string,object>)original["files"];
                if(files.Count!=originalFiles.Count) throw new InvalidDataException("Manifest file count changed.");
                foreach(var item in originalFiles) if(item.Key!=UpdateSpec.Launcher && UpdaterCore.JsonText(item.Value)!=UpdaterCore.JsonText(files[item.Key])) throw new InvalidDataException("Unrelated manifest row changed: "+item.Key);
                if(Convert.ToString(manifest["version"])!=spec.Version) throw new InvalidDataException("Manifest version differs.");
                Console.WriteLine(UpdaterCore.JsonText(new Dictionary<string,object> { {"ok",true},{"version",spec.Version},{"appBytes",spec.Bytes},{"appSha256",spec.Sha256},{"manifestRows",files.Count},{"unrelatedManifestRowsUnchanged",true},{"embeddedResourceExact",true},{"networkRequired",false},{"probeFolder",root} }));
                return 0;
            } catch(Exception error) { Console.Error.WriteLine(error); return 1; }
        }
    }
}
