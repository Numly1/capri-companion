$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$synth = $null
$audio = $null
try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $speechText = [string]$request.text
    $language = if ($request.language -eq 'ja') { 'ja' } else { 'ru' }
    if ([string]::IsNullOrWhiteSpace($speechText) -or $speechText.Length -gt 1200) { throw 'text' }
    Add-Type -AssemblyName System.Speech
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.TwoLetterISOLanguageName -eq $language })
    $chosen = $voices | Where-Object { $_.VoiceInfo.Gender -eq [System.Speech.Synthesis.VoiceGender]::Female } | Select-Object -First 1
    if (-not $chosen) { $chosen = $voices | Select-Object -First 1 }
    if (-not $chosen) {
        @{ok=$false;error='Голос выбранного языка не установлен в Windows.'} | ConvertTo-Json -Compress
        exit 0
    }
    $synth.SelectVoice($chosen.VoiceInfo.Name)
    $synth.Rate = 1
    $audio = New-Object System.IO.MemoryStream
    $synth.SetOutputToWaveStream($audio)
    $synth.Speak($speechText)
    @{ok=$true;audio=[Convert]::ToBase64String($audio.ToArray());voice=$chosen.VoiceInfo.Name;synthetic=$true} | ConvertTo-Json -Compress
} catch {
    @{ok=$false;error='Не удалось озвучить фразу голосом Windows.'} | ConvertTo-Json -Compress
} finally {
    if ($synth) { $synth.Dispose() }
    if ($audio) { $audio.Dispose() }
}
