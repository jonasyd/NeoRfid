$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:ANDROID_SDK_ROOT = "$env:LOCALAPPDATA\Android\Sdk"

$jdk17 = Get-ChildItem "C:\Program Files\Eclipse Adoptium" -Directory |
    Where-Object { $_.Name -like "jdk-17*" } |
    Select-Object -First 1

if (-not $jdk17) {
    Write-Error "No se encontró JDK 17 en C:\Program Files\Eclipse Adoptium"
    exit 1
}

$env:JAVA_HOME = $jdk17.FullName
$env:Path = "$env:JAVA_HOME\bin;$env:Path"

Write-Host "JAVA_HOME = $env:JAVA_HOME"
java -version

if (Test-Path "android") {
    Write-Host "Limpiando directorio android existente..."
    Remove-Item -Recurse -Force android
}


npx expo run:android