# Explicit, one-shot local OCR. Screenshots exist only in memory; nothing is uploaded or saved.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$bitmap = $null; $graphics = $null; $png = $null; $random = $null; $software = $null
try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    Add-Type -AssemblyName System.Drawing
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    Add-Type -TypeDefinition @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class CapriLocalScreen {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint id);
    public static string Foreground(int excludedPid) {
        uint id; GetWindowThreadProcessId(GetForegroundWindow(), out id);
        if(id == excludedPid) return "";
        try { using(var p = Process.GetProcessById((int)id)) return p.ProcessName; } catch { return ""; }
    }
}
"@
    [void][CapriLocalScreen]::SetProcessDPIAware()
    $app = [CapriLocalScreen]::Foreground([int]$request.excludePid)
    $engineType = [Windows.Media.Ocr.OcrEngine,Windows.Media.Ocr,ContentType=WindowsRuntime]
    $decoderType = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
    $softwareType = [Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
    $resultType = [Windows.Media.Ocr.OcrResult,Windows.Media.Ocr,ContentType=WindowsRuntime]
    $pixelType = [Windows.Graphics.Imaging.BitmapPixelFormat,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
    $alphaType = [Windows.Graphics.Imaging.BitmapAlphaMode,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
    $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1
    function Await-Local($operation, [Type]$type) {
        $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
        if (-not $task.Wait(7000)) { throw 'timeout' }
        return $task.GetAwaiter().GetResult()
    }
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if (-not $engine) {
        $languages = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages)
        if ($languages.Count -gt 0) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($languages[0]) }
    }
    if (-not $engine) {
        @{ok=$false;code='ocr_unavailable';app=$app} | ConvertTo-Json -Compress
        exit 0
    }
    if ($request.fixture -eq $true) {
        # Test fixture exercises the real OCR engine without reading the user's screen.
        $bitmap = [System.Drawing.Bitmap]::new(1200, 200)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.Clear([System.Drawing.Color]::White)
        $font = [System.Drawing.Font]::new('Arial', 34)
        try { $graphics.DrawString('CAPRI LOCAL OCR', $font, [System.Drawing.Brushes]::Black, 25, 45) }
        finally { $font.Dispose() }
        $app = ''
    } else {
        $b = $request.bounds
        $x = [int]$b.x; $y = [int]$b.y; $width = [int]$b.width; $height = [int]$b.height
        if ($width -lt 1 -or $height -lt 1 -or $width -gt 8192 -or $height -gt 8192 -or
            ([long]$width * $height) -gt 33554432 -or [Math]::Abs($x) -gt 32768 -or [Math]::Abs($y) -gt 32768) { throw 'bounds' }
        $bitmap = [System.Drawing.Bitmap]::new($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppPArgb)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.CopyFromScreen($x, $y, 0, 0, $bitmap.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
    }
    $graphics.Dispose(); $graphics = $null
    $limit = [Math]::Min(4096, [Windows.Media.Ocr.OcrEngine]::MaxImageDimension)
    if ($bitmap.Width -gt $limit -or $bitmap.Height -gt $limit) {
        $ratio = [Math]::Min($limit / $bitmap.Width, $limit / $bitmap.Height)
        $scaled = [System.Drawing.Bitmap]::new($bitmap, [int]($bitmap.Width * $ratio), [int]($bitmap.Height * $ratio))
        $bitmap.Dispose(); $bitmap = $scaled
    }
    $png = [System.IO.MemoryStream]::new()
    $bitmap.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
    $png.Position = 0
    $random = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($png)
    $decoder = Await-Local ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($random)) $decoderType
    $software = Await-Local ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) $softwareType
    $result = Await-Local ($engine.RecognizeAsync($software)) $resultType
    $lines = @($result.Lines | ForEach-Object { $_.Text })
    $text = ($lines -join "`n").Trim()
    if ($text.Length -gt 3000) { $text = $text.Substring(0, 3000) }
    @{ok=$true;text=$text;app=$app;language=$engine.RecognizerLanguage.LanguageTag;local=$true} | ConvertTo-Json -Compress
} catch {
    @{ok=$false;code='capture_failed'} | ConvertTo-Json -Compress
} finally {
    if ($software) { $software.Dispose() }
    if ($random) { $random.Dispose() }
    if ($png) { $png.Dispose() }
    if ($graphics) { $graphics.Dispose() }
    if ($bitmap) { $bitmap.Dispose() }
}
