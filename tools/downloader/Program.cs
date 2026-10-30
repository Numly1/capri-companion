using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace CapriReadyDownload {
    internal static class Program {
        [STAThread] static void Main() {
            DownloaderCore.ConfigurePaths();
            ServicePointManager.SecurityProtocol=SecurityProtocolType.Tls12;
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            if(!Environment.Is64BitOperatingSystem) { MessageBox.Show("Для этой Капри нужна 64-битная Windows 10 или 11.","Капри"); return; }
            Application.Run(new ReadyForm());
        }
    }
    internal sealed class ReadyForm : Form {
        readonly Label status=new Label(); readonly Label pathLabel=new Label();
        readonly ProgressBar bar=new ProgressBar(); readonly Button choose=new Button();
        readonly Button start=new Button(); readonly Button cancel=new Button();
        CancellationTokenSource cancellation; bool busy,closeRequested; string parent;
        readonly string settings=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"CapriReadyDownloader","folder.txt");
        public ReadyForm() {
            Text="Капри — первый запуск"; ClientSize=new Size(550,315); StartPosition=FormStartPosition.CenterScreen;
            FormBorderStyle=FormBorderStyle.FixedDialog; MaximizeBox=false; AutoScaleMode=AutoScaleMode.Dpi;
            try { Icon=Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
            Font=new Font("Segoe UI",9F); BackColor=Color.FromArgb(20,14,32); ForeColor=Color.FromArgb(246,240,250);
            var heading=new Label { Text="Капри уже ждёт тебя",Font=new Font("Segoe UI",18F,FontStyle.Bold),AutoSize=true,Location=new Point(24,20) };
            var intro=new Label { Text="Скачаю готовый голос и последнюю версию приложения.\nПервое скачивание — около "+(BuildInfo.Bundle.UpdateUri!=null?"4,3":"4,2")+" ГБ. Уже есть Капри? Нужен Capri-Update.exe.",Location=new Point(26,65),Size=new Size(500,48) };
            pathLabel.Location=new Point(26,121); pathLabel.Size=new Size(375,34); pathLabel.AutoEllipsis=true;
            choose.Text="Другая папка…"; choose.Location=new Point(407,120); choose.Size=new Size(117,30);
            status.Location=new Point(26,167); status.Size=new Size(498,46); status.Text="Подготовка…";
            bar.Location=new Point(26,218); bar.Size=new Size(498,9); bar.Maximum=1000;
            start.Text="Скачать и запустить"; start.Location=new Point(26,251); start.Size=new Size(190,35);
            cancel.Text="Отмена"; cancel.Location=new Point(416,251); cancel.Size=new Size(108,35); cancel.Enabled=false;
            foreach(var button in new[]{choose,start,cancel}) { button.FlatStyle=FlatStyle.Flat; button.BackColor=Color.FromArgb(46,32,65); button.ForeColor=ForeColor; }
            start.BackColor=Color.FromArgb(112,44,225);
            Controls.AddRange(new Control[]{heading,intro,pathLabel,choose,status,bar,start,cancel});
            parent=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"CapriReady");
            try { if(File.Exists(settings)) { var saved=File.ReadAllText(settings).Trim(); if(Path.IsPathRooted(saved)) { var full=Path.GetFullPath(saved); if(!Path.GetPathRoot(full).StartsWith("\\\\")) parent=full; } } } catch { }
            UpdatePath();
            choose.Click+=delegate { using(var dialog=new FolderBrowserDialog { Description="Где сохранить папку Капри? Нужно примерно 11 ГБ свободного места.",SelectedPath=Directory.Exists(parent)?parent:Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments) }) {
                if(dialog.ShowDialog(this)==DialogResult.OK) { parent=dialog.SelectedPath; UpdatePath(); SaveFolder(); status.Text="Папка выбрана. Нажми «Скачать и запустить»."; start.Text="Скачать и запустить"; }
            }};
            start.Click+=async delegate { await StartSetup(); };
            cancel.Click+=delegate { CancelSetup(); };
#if !PREVIEW_BUILD
            Shown+=async delegate { await StartSetup(); };
#endif
            FormClosing+=delegate(object sender,FormClosingEventArgs e) { if(busy) { e.Cancel=true; closeRequested=true; CancelSetup(); } };
        }
        void UpdatePath() { pathLabel.Text="Папка Капри:\n"+DownloaderCore.FinalDirectory(parent,BuildInfo.Bundle); }
        void SaveFolder() { try { Directory.CreateDirectory(Path.GetDirectoryName(settings)); File.WriteAllText(settings,parent); } catch { } }
        void CancelSetup() { if(cancellation!=null) { cancellation.Cancel(); cancel.Enabled=false; status.Text="Останавливаю загрузку…"; } }
        async Task StartSetup() {
            if(busy) return; busy=true; start.Enabled=false; choose.Enabled=false; cancel.Enabled=true; cancellation=new CancellationTokenSource();
            SaveFolder();
            try {
                var progress=new Progress<SetupProgress>(delegate(SetupProgress value) { if(IsDisposed || Disposing) return; status.Text=value.Message; bar.Value=(int)(value.Fraction*1000); });
                var folder=await DownloaderCore.Install(BuildInfo.Bundle,parent,progress,cancellation.Token);
                cancellation.Token.ThrowIfCancellationRequested();
                Directory.CreateDirectory(Path.GetDirectoryName(settings)); File.WriteAllText(settings,parent);
                status.Text="Готово! В следующий раз этот же файл откроет Капри без повторной загрузки."; bar.Value=1000;
                Process.Start(new ProcessStartInfo(Path.Combine(folder,BuildInfo.Bundle.LauncherName)) { WorkingDirectory=folder, UseShellExecute=true });
                await Task.Delay(1800); Close();
            } catch(Exception error) {
                if(cancellation.IsCancellationRequested) status.Text="Загрузка остановлена. Готовые части сохранены — можно продолжить позже.";
                else if(error is UnauthorizedAccessException) status.Text="Нет доступа к выбранной папке. Нажми «Другая папка…» и выбери папку на своём диске.";
                else if(error is TimeoutException) status.Text=error.Message;
                else if(error is IOException || error is InvalidDataException) status.Text=error.Message;
                else status.Text="Не удалось закончить загрузку. Проверь интернет и нажми «Повторить». Готовые части сохранены.";
                start.Text="Повторить";
            } finally {
                busy=false; start.Enabled=true; choose.Enabled=true; cancel.Enabled=false; cancellation.Dispose(); cancellation=null;
                if(closeRequested) Close();
            }
        }
    }
}
