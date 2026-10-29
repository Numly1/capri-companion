using System;
using System.Drawing;
using CapriReadyDownload;
internal static class Preview {
    [STAThread] static void Main(string[] args) {
        DownloaderCore.ConfigurePaths();
        System.Windows.Forms.Application.EnableVisualStyles();
        System.Windows.Forms.Application.SetCompatibleTextRenderingDefault(false);
        using(var form=new ReadyForm()) {
            form.StartPosition=System.Windows.Forms.FormStartPosition.Manual; form.Location=new Point(-10000,-10000); form.ShowInTaskbar=false;
            form.Show(); System.Windows.Forms.Application.DoEvents();
            using(var bitmap=new Bitmap(form.Width,form.Height)) {
                form.DrawToBitmap(bitmap,new Rectangle(0,0,bitmap.Width,bitmap.Height));
                bitmap.Save(args[0],System.Drawing.Imaging.ImageFormat.Png);
            }
            form.Close();
        }
    }
}
