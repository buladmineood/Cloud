# Създава сертификат за вход на cloud в Microsoft и тайните в worker/.dev.vars. Пуска се веднъж:
#   powershell -ExecutionPolicy Bypass -File scripts\new-certificate.ps1
# Публичната част отива в .secrets/buladmin-cloud.cer (качва я setup-microsoft.mjs), а частният ключ
# само в .dev.vars. Отпечатва MS_CERT_THUMBPRINT за wrangler.toml. Не презаписва съществуващи тайни.
$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot '..'
$secrets = Join-Path $root '.secrets'
$devVars = Join-Path $root '.dev.vars'
New-Item -ItemType Directory -Force $secrets | Out-Null

function Base64Url([byte[]]$bytes) { [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_') }
function RandomSecret { $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); Base64Url $b }

$vars = [ordered]@{}
if (Test-Path $devVars) {
  foreach ($line in Get-Content $devVars) { if ($line -match '^([A-Z_]+)=(.*)$') { $vars[$Matches[1]] = $Matches[2] } }
}

if (-not $vars['MS_CERT_PRIVATE_KEY']) {
  # Ключът се създава като CNG ключ с разрешен износ, за да се извади в PKCS#8 за Cloudflare.
  $params = New-Object Security.Cryptography.CngKeyCreationParameters
  $params.ExportPolicy = [Security.Cryptography.CngExportPolicies]::AllowPlaintextExport
  $params.Parameters.Add((New-Object Security.Cryptography.CngProperty('Length', [BitConverter]::GetBytes(2048), [Security.Cryptography.CngPropertyOptions]::None)))
  $key = [Security.Cryptography.CngKey]::Create([Security.Cryptography.CngAlgorithm]::Rsa, [NullString]::Value, $params)
  $rsa = New-Object Security.Cryptography.RSACng($key)
  $request = New-Object Security.Cryptography.X509Certificates.CertificateRequest('CN=BULADMIN Cloud', $rsa, [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
  $cert = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-1), [DateTimeOffset]::UtcNow.AddYears(2))
  [IO.File]::WriteAllBytes((Join-Path $secrets 'buladmin-cloud.cer'), $cert.RawData)
  $vars['MS_CERT_PRIVATE_KEY'] = [Convert]::ToBase64String($key.Export([Security.Cryptography.CngKeyBlobFormat]::Pkcs8PrivateBlob))
  $sha = [Security.Cryptography.SHA256]::Create().ComputeHash($cert.RawData)
  Write-Host "MS_CERT_THUMBPRINT=$(Base64Url $sha)"
  Write-Host "Valid until $($cert.NotAfter.ToString('yyyy-MM-dd'))"
}
if (-not $vars['SESSION_SECRET']) { $vars['SESSION_SECRET'] = RandomSecret }
if (-not $vars['PASSWORD_PEPPER']) { $vars['PASSWORD_PEPPER'] = RandomSecret }

$lines = $vars.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }
[IO.File]::WriteAllLines($devVars, [string[]]$lines)
Write-Host "Saved: $($vars.Keys -join ', ')"
