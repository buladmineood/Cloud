# Създава SharePoint сайта за данните на cloud (/sites/cloud). Пуска се веднъж от глобален или SharePoint администратор:
#   powershell -ExecutionPolicy Bypass -File scripts\setup-site.ps1 -Owner ime@bulmail.eu
# Ако сайтът вече съществува, нищо не се променя.
param([Parameter(Mandatory = $true)][string]$Owner)
$ErrorActionPreference = 'Stop'

$toml = Get-Content (Join-Path $PSScriptRoot '..\wrangler.toml') -Raw
$hostName = [regex]::Match($toml, 'SP_HOSTNAME = "(.*)"').Groups[1].Value
$sitePath = [regex]::Match($toml, 'SP_SITE_PATH = "(.*)"').Groups[1].Value
$siteUrl = "https://$hostName$sitePath"
$adminUrl = "https://$($hostName.Split('.')[0])-admin.sharepoint.com"

Import-Module Microsoft.Online.SharePoint.PowerShell -DisableNameChecking -WarningAction SilentlyContinue
Write-Host "Влезте като администратор в прозореца, който ще се отвори ($adminUrl)."
Connect-SPOService -Url $adminUrl

$site = $null
try { $site = Get-SPOSite -Identity $siteUrl -ErrorAction Stop } catch { }
if ($site) {
  Write-Host "Сайтът съществува: $siteUrl"
} else {
  # Екипен сайт без Microsoft 365 група: членовете му виждат таблиците, затова достъпът се дава само изрично.
  New-SPOSite -Url $siteUrl -Owner $Owner -StorageQuota 1024 -Title 'BulAdmin Cloud' -Template 'STS#3' -TimeZoneId 7 -LocaleId 1026
  Write-Host "Създаден сайт: $siteUrl"
}
# Без външно споделяне: данните са вътрешни.
Set-SPOSite -Identity $siteUrl -SharingCapability Disabled
Disconnect-SPOService
Write-Host 'ГОТОВО'
