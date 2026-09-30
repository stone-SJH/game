param([Parameter(Mandatory=$true)][string]$Source, [Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$inputImage = [Drawing.Image]::FromFile($Source)
try {
  $ratio = [Math]::Min(1.0, 1280.0 / [Math]::Max($inputImage.Width, $inputImage.Height))
  $bitmap = New-Object Drawing.Bitmap ([int][Math]::Max(1, [Math]::Round($inputImage.Width * $ratio))), ([int][Math]::Max(1, [Math]::Round($inputImage.Height * $ratio)))
  try {
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.Clear([Drawing.Color]::White)
      $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.DrawImage($inputImage, 0, 0, $bitmap.Width, $bitmap.Height)
    } finally { $graphics.Dispose() }
    $bitmap.Save($Destination, [Drawing.Imaging.ImageFormat]::Jpeg)
  } finally { $bitmap.Dispose() }
} finally { $inputImage.Dispose() }
