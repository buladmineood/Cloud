# Позволява на приложението „BULADMIN Cloud“ да праща САМО от no-reply@cloud.buladmin.eu (Exchange RBAC for Applications)
# и включва DKIM подписа за cloud.buladmin.eu. Пуска се след setup-microsoft.mjs и след като домейнът е потвърден,
# от Exchange администратор:
#   powershell -ExecutionPolicy Bypass -File scripts\setup-mail.ps1
# Може да се пуска повторно. Никога не давайте Mail.Send на приложението в Entra: правото важи за всички кутии в tenant-а.
# https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac
$ErrorActionPreference = 'Stop'
$Domain = 'cloud.buladmin.eu'
$Address = "no-reply@$Domain"
$DisplayName = 'BULADMIN Cloud'
$ScopeName = 'BULADMIN Cloud Mailboxes'
$Marker = 'BuladminCloudMail'

$toml = Get-Content (Join-Path $PSScriptRoot '..\wrangler.toml') -Raw
$AppId = [regex]::Match($toml, 'MS_CLIENT_ID = "(.*)"').Groups[1].Value
$ObjectId = (Get-Content (Join-Path $PSScriptRoot '..\.secrets\service-principal-id.txt') -Raw).Trim()

if (-not (Get-Module -ListAvailable -Name ExchangeOnlineManagement)) {
  Install-Module ExchangeOnlineManagement -Scope CurrentUser -Force
}
Import-Module ExchangeOnlineManagement
# -DisableWAM влиза през браузъра, така работи и без конзолен прозорец.
Connect-ExchangeOnline -ShowBanner:$false -DisableWAM

if (-not (Get-AcceptedDomain -Identity $Domain -ErrorAction SilentlyContinue)) {
  throw "Домейнът $Domain още не е приет в Exchange. Добавете DNS записите от setup-microsoft.mjs, пуснете го отново и опитайте след няколко минути."
}

if (Get-Mailbox -Identity $Address -ErrorAction SilentlyContinue) {
  Write-Host "Кутията съществува: $Address"
} else {
  New-Mailbox -Shared -Name 'BULADMIN Cloud No-Reply' -DisplayName 'BulAdmin CRM / ERP' -Alias 'cloud-no-reply' -PrimarySmtpAddress $Address | Out-Null
  Write-Host "Създадена споделена кутия: $Address"
}
Set-Mailbox -Identity $Address -CustomAttribute15 $Marker

if (-not (Get-ServicePrincipal -Identity $ObjectId -ErrorAction SilentlyContinue)) {
  New-ServicePrincipal -AppId $AppId -ObjectId $ObjectId -DisplayName $DisplayName | Out-Null
}
if (-not (Get-ManagementScope -Identity $ScopeName -ErrorAction SilentlyContinue)) {
  New-ManagementScope -Name $ScopeName -RecipientRestrictionFilter "CustomAttribute15 -eq '$Marker'" | Out-Null
}
$assignment = Get-ManagementRoleAssignment -Role 'Application Mail.Send' -ErrorAction SilentlyContinue |
  Where-Object { $_.CustomResourceScope -eq $ScopeName -and $_.RoleAssignee -eq $ObjectId }
if (-not $assignment) {
  New-ManagementRoleAssignment -App $ObjectId -Role 'Application Mail.Send' -CustomResourceScope $ScopeName | Out-Null
}

# DKIM: подписва имейлите с cloud.buladmin.eu. Двата CNAME записа трябва да са в DNS; иначе се показват тук.
try {
  Set-DkimSigningConfig -Identity $Domain -Enabled $true -ErrorAction Stop
} catch {
  try { New-DkimSigningConfig -DomainName $Domain -Enabled $true -ErrorAction Stop | Out-Null } catch { Write-Host "DKIM още не е включен: $($_.Exception.Message)" }
}
Get-DkimSigningConfig -Identity $Domain -ErrorAction SilentlyContinue | ForEach-Object {
  Write-Host "DKIM Enabled=$($_.Enabled) Status=$($_.Status)"
  Write-Host "DNS-DKIM CNAME selector1._domainkey.$Domain   $($_.Selector1CNAME)"
  Write-Host "DNS-DKIM CNAME selector2._domainkey.$Domain   $($_.Selector2CNAME)"
}

# InScope трябва да е True за no-reply и False за Вашата кутия.
Write-Host ''
$me = (Get-ConnectionInformation | Select-Object -First 1).UserPrincipalName
foreach ($resource in @($Address, $me)) {
  $result = Test-ServicePrincipalAuthorization -Identity $ObjectId -Resource $resource |
    Where-Object { $_.RoleName -eq 'Application Mail.Send' }
  Write-Host "$resource InScope=$($result.InScope)"
}
Disconnect-ExchangeOnline -Confirm:$false
Write-Host 'ГОТОВО. Exchange може да приложи правата след 30 минути до 2 часа.'
