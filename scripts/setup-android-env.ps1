# setup-android-env.ps1
# Configures a fully portable, self-contained Android build environment in .tools
$ErrorActionPreference = "Stop"

$RootDir = (Resolve-Path "$PSScriptRoot\..").Path
$ToolsDir = Join-Path $RootDir ".tools"
$JdkDir = Join-Path $ToolsDir "jdk-17"
$SdkDir = Join-Path $ToolsDir "android-sdk"
$CmdlineToolsLatest = Join-Path $SdkDir "cmdline-tools\latest"

if (-not (Test-Path $ToolsDir)) {
    New-Item -ItemType Directory -Path $ToolsDir | Out-Null
}

# 1. Download and extract Portable JDK 17
$JavaExe = Join-Path $JdkDir "bin\java.exe"
if (-not (Test-Path $JavaExe)) {
    Write-Host "[1/4] Baixando OpenJDK 17 portátil..."
    $JdkZip = Join-Path $ToolsDir "openjdk-17.zip"
    $JdkUrl = "https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse?project=jdk"
    Invoke-WebRequest -Uri $JdkUrl -OutFile $JdkZip
    
    Write-Host "Extraindo OpenJDK 17 em $JdkDir..."
    $TempExtract = Join-Path $ToolsDir "jdk-temp"
    if (Test-Path $TempExtract) { Remove-Item -Recurse -Force $TempExtract }
    Expand-Archive -Path $JdkZip -DestinationPath $TempExtract -Force
    
    $ExtractedSubdir = Get-ChildItem -Path $TempExtract -Directory | Select-Object -First 1
    Move-Item -Path $ExtractedSubdir.FullName -Destination $JdkDir -Force
    Remove-Item -Recurse -Force $TempExtract
    Remove-Item -Force $JdkZip
    Write-Host "OpenJDK 17 configurado com sucesso."
} else {
    Write-Host "OpenJDK 17 já instalado em $JdkDir."
}

# 2. Download and extract Android Command Line Tools
$SdkManagerBat = Join-Path $CmdlineToolsLatest "bin\sdkmanager.bat"
if (-not (Test-Path $SdkManagerBat)) {
    Write-Host "[2/4] Baixando Android Command Line Tools via curl..."
    $CmdlineZip = Join-Path $ToolsDir "cmdline-tools.zip"
    $CmdlineUrl = "https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip"
    curl.exe -L -o $CmdlineZip $CmdlineUrl
    
    Write-Host "Extraindo Command Line Tools..."
    $TempExtract = Join-Path $ToolsDir "cmdline-temp"
    if (Test-Path $TempExtract) { Remove-Item -Recurse -Force $TempExtract }
    Expand-Archive -Path $CmdlineZip -DestinationPath $TempExtract -Force
    
    if (-not (Test-Path (Join-Path $SdkDir "cmdline-tools"))) {
        New-Item -ItemType Directory -Path (Join-Path $SdkDir "cmdline-tools") -Force | Out-Null
    }
    Move-Item -Path (Join-Path $TempExtract "cmdline-tools") -Destination $CmdlineToolsLatest -Force
    Remove-Item -Recurse -Force $TempExtract
    Remove-Item -Force $CmdlineZip
    Write-Host "Command Line Tools configurado."
} else {
    Write-Host "Command Line Tools já instalado."
}

# 3. Configure environment and install Android SDK packages
Write-Host "[3/4] Instalando Android SDK Platform 34 e Build Tools..."
$env:JAVA_HOME = $JdkDir
$env:PATH = "$($JdkDir)\bin;$($CmdlineToolsLatest)\bin;$env:PATH"
$env:ANDROID_HOME = $SdkDir
$env:ANDROID_SDK_ROOT = $SdkDir

# Accept licenses
$LicensesDir = Join-Path $SdkDir "licenses"
if (-not (Test-Path $LicensesDir)) {
    New-Item -ItemType Directory -Path $LicensesDir -Force | Out-Null
}
# Accept standard licenses hashes
@'
24333f8a63b6825ea9c5514f83c2829b004d1fee
84831b9409646a918e30573bab4c9c91346d8abd
d97544455e50abf004e949005b68713130dd3045
'@ | Set-Content -Path (Join-Path $LicensesDir "android-sdk-license") -NoNewline

@'
8564832314fce80c486075236eb0830f76070c47
'@ | Set-Content -Path (Join-Path $LicensesDir "android-sdk-arm-dbt-license") -NoNewline

# Run sdkmanager to install platforms and build-tools
& $SdkManagerBat --sdk_root=$SdkDir "platform-tools" "platforms;android-34" "build-tools;34.0.0"

# 4. Generate local.properties for Gradle
Write-Host "[4/4] Gerando local.properties..."
$AndroidDir = Join-Path $RootDir "android"
if (-not (Test-Path $AndroidDir)) {
    New-Item -ItemType Directory -Path $AndroidDir -Force | Out-Null
}
$EscapedSdkDir = $SdkDir.Replace("\", "\\").Replace(":", "\:")
"sdk.dir=$EscapedSdkDir`n" | Set-Content -Path (Join-Path $AndroidDir "local.properties") -NoNewline

Write-Host "Ambiente Android configurado com sucesso 100% no disco F:!"
