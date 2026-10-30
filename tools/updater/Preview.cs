using System;
using System.Drawing;
using System.Windows.Forms;
namespace CapriReadyUpdate {
    internal static class Preview {
        [STAThread] static void Main(string[] args) {
            UpdaterCore.ConfigurePaths(); Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            using(var form=new UpdateForm()) {
                form.StartPosition=FormStartPosition.Manual; form.Location=new Point(-10000,-10000); form.ShowInTaskbar=false;
                form.Show(); Application.DoEvents();
                using(var bitmap=new Bitmap(form.Width,form.Height)) {
                    form.DrawToBitmap(bitmap,new Rectangle(0,0,bitmap.Width,bitmap.Height));
                    bitmap.Save(args[0],System.Drawing.Imaging.ImageFormat.Png);
                }
                form.Close();
            }
        }
    }
}
