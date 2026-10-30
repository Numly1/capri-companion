using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace CapriReadyUpdate {
    internal static class Program {
        [STAThread] static void Main() {
            UpdaterCore.ConfigurePaths(); Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            if(!Environment.Is64BitOperatingSystem) { MessageBox.Show("Нужна 64-битная Windows 10 или 11.","Капри"); return; }
            Application.Run(new UpdateForm());
        }
    }
    internal sealed class UpdateForm : Form {
        readonly Label folderLabel=new Label(), status=new Label(); readonly Button choose=new Button(), start=new Button(), cancel=new Button();
        readonly CheckBox launch=new CheckBox(); readonly ProgressBar bar=new ProgressBar();
        CancellationTokenSource cancellation; bool busy,closeRequested; string folder;
        public UpdateForm() {
            Text="Капри — обновление без загрузки голоса"; ClientSize=new Size(600,354); StartPosition=FormStartPosition.CenterScreen;
            FormBorderStyle=FormBorderStyle.FixedDialog; MaximizeBox=false; AutoScaleMode=AutoScaleMode.Dpi;
            try { Icon=Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
            Font=new Font("Segoe UI",9F); BackColor=Color.FromArgb(20,14,32); ForeColor=Color.FromArgb(246,240,250);
            var heading=new Label { Text="Новая Капри, тот же голос",Font=new Font("Segoe UI",18F,FontStyle.Bold),AutoSize=true,Location=new Point(24,20) };
            var intro=new Label { Text="Обновится только приложение. Скачанный голос, API-ключ и переписка сохранятся.\nСначала закрой Капри: правой кнопкой по персонажу → «Выйти».",Location=new Point(26,67),Size=new Size(548,48) };
            folderLabel.Location=new Point(26,124); folderLabel.Size=new Size(390,42); folderLabel.AutoEllipsis=true;
            choose.Text="Найти папку…"; choose.Location=new Point(438,124); choose.Size=new Size(136,32);
            status.Location=new Point(26,177); status.Size=new Size(548,47);
            bar.Location=new Point(26,229); bar.Size=new Size(548,10); bar.Style=ProgressBarStyle.Blocks;
            launch.Text="Запустить Капри после обновления"; launch.Checked=true; launch.AutoSize=true; launch.Location=new Point(26,254);
            start.Text="Обновить"; start.Location=new Point(26,297); start.Size=new Size(190,35);
            cancel.Text="Закрыть"; cancel.Location=new Point(466,297); cancel.Size=new Size(108,35);
            foreach(var button in new[]{choose,start,cancel}) { button.FlatStyle=FlatStyle.Flat; button.BackColor=Color.FromArgb(46,32,65); button.ForeColor=ForeColor; }
            start.BackColor=Color.FromArgb(112,44,225);
            Controls.AddRange(new Control[]{heading,intro,folderLabel,choose,status,bar,launch,start,cancel});
            var local=Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            folder=UpdaterCore.DetectFolder(Path.Combine(local,"CapriReadyDownloader","folder.txt"),AppDomain.CurrentDomain.BaseDirectory,Environment.CurrentDirectory,local);
            RefreshFolder();
            status.Text=folder==null?"Нажми «Найти папку…» и выбери старую папку Капри, где находится «Запустить Капри.exe».":"Папка найдена. Закрой старую Капри и нажми «Обновить».";
            choose.Click+=delegate { using(var dialog=new FolderBrowserDialog { Description="Выбери уже скачанную папку Капри с файлом «Запустить Капри.exe». Новую папку создавать не нужно.",ShowNewFolderButton=false,SelectedPath=folder??Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments) }) {
                if(dialog.ShowDialog(this)!=DialogResult.OK) return;
                try { folder=UpdaterCore.ValidateFolder(dialog.SelectedPath); RefreshFolder(); status.Text="Папка выбрана. Закрой старую Капри и нажми «Обновить»."; }
                catch(Exception error) { status.Text=error.Message; }
            }};
            start.Click+=async delegate { await RunUpdate(); };
            cancel.Click+=delegate { if(busy) { closeRequested=true; cancellation.Cancel(); cancel.Enabled=false; } else Close(); };
            FormClosing+=delegate(object sender,FormClosingEventArgs e) { if(busy) { e.Cancel=true; closeRequested=true; cancellation.Cancel(); } };
        }
        void RefreshFolder() { folderLabel.Text="Папка Капри:\n"+(folder??"не найдена автоматически"); start.Enabled=folder!=null; }
        async Task RunUpdate() {
            if(busy || folder==null) return; busy=true; choose.Enabled=false; start.Enabled=false; launch.Enabled=false; cancel.Text="Отмена";
            bar.Style=ProgressBarStyle.Marquee; cancellation=new CancellationTokenSource(); bool open=launch.Checked;
            var progress=new Progress<string>(delegate(string text) { if(!IsDisposed) status.Text=text; });
            try {
                var launcher=await Task.Run(delegate { return UpdaterCore.Apply(folder,BuildInfo.Spec,
                    delegate { var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("Capri.Application.exe"); if(stream==null) throw new InvalidDataException("В обновлении отсутствует приложение."); return stream; },
                    cancellation.Token,delegate(string text) { ((IProgress<string>)progress).Report(text); }); });
                status.Text="Готово! Голос, API-ключ и переписка сохранены. Для следующих запусков открывай «Запустить Капри.exe» в этой папке.";
                bar.Style=ProgressBarStyle.Blocks; bar.Value=100; start.Text="Обновлено";
                if(open && !closeRequested) { Process.Start(new ProcessStartInfo(launcher) {WorkingDirectory=folder,UseShellExecute=true}); await Task.Delay(1200); closeRequested=true; }
            } catch(OperationCanceledException) { status.Text="Обновление отменено. Можно повторить позже."; }
            catch(Exception error) { status.Text=error is UnauthorizedAccessException?"Нет доступа к папке или Капри ещё работает. Закрой её через «Выйти» и повтори.":error.Message; }
            finally { busy=false; cancellation.Dispose(); cancellation=null; choose.Enabled=true; start.Enabled=true; launch.Enabled=true; cancel.Enabled=true; cancel.Text="Закрыть"; bar.Style=ProgressBarStyle.Blocks; if(closeRequested) Close(); }
        }
    }
}
