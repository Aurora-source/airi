param([ValidateSet('code','browser','terminal','media','desktop','changed-window')][string]$Scene)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap 960,540
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$font = New-Object System.Drawing.Font 'Consolas',18
$small = New-Object System.Drawing.Font 'Consolas',14
try {
  $graphics.Clear([System.Drawing.Color]::FromArgb(30,34,42))
  $graphics.FillRectangle([System.Drawing.Brushes]::DarkSlateGray,0,0,960,48)
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  switch ($Scene) {
    'code' {
      $title = 'Code Editor - demo.ts'
      $lines = @('function greet(name: string) {','  return `Hello, ${name}`','}','', 'const message = greet("World")', 'console.info(message)', '', 'STATUS: No errors')
    }
    'browser' {
      $title = 'Browser - Public Recipe Demo'
      $lines = @('https://example.invalid/recipe', '', 'Simple Tomato Soup', '', 'Ingredients: tomatoes, water, salt', '', '1. Chop the tomatoes', '2. Simmer for 20 minutes')
    }
    'terminal' {
      $title = 'Terminal - demo server'
      $lines = @('PS C:Demo> npm run dev', '', 'Starting demo server...', 'Server ready at localhost:3000', '', 'GET /health 200 OK', 'Tests: 12 passed, 0 failed', '', 'PS C:Demo> _')
    }
    'media' {
      $title = 'Video Player - Moonlight animation'
      $graphics.FillRectangle([System.Drawing.Brushes]::MidnightBlue,40,80,880,330)
      $graphics.FillEllipse([System.Drawing.Brushes]::LightYellow,670,100,100,100)
      $graphics.FillPolygon([System.Drawing.Brushes]::DarkGreen,[System.Drawing.Point[]]@((New-Object System.Drawing.Point 40,410),(New-Object System.Drawing.Point 260,240),(New-Object System.Drawing.Point 500,410)))
      $graphics.DrawString('A quiet night under the moon.',$small,[System.Drawing.Brushes]::White,230,360)
      $graphics.DrawString('Paused   00:42 / 02:10',$font,[System.Drawing.Brushes]::White,80,455)
      $lines = @()
    }
    'desktop' {
      $title = 'Desktop - Reference workspace'
      $graphics.FillRectangle([System.Drawing.Brushes]::SteelBlue,0,48,960,440)
      $lines = @('Documents', '', 'Browser', '', 'Recycle Bin')
      $graphics.FillRectangle([System.Drawing.Brushes]::Black,0,490,960,50)
      $graphics.DrawString('Start     Apps                                   12:00',$small,[System.Drawing.Brushes]::White,20,505)
    }
    'changed-window' {
      $title = 'Settings - Network'
      $lines = @('Network Settings', '', 'Wi-Fi: Connected', 'Signal: Strong', '', 'Airplane mode: OFF', '', 'Connection status: Online')
    }
  }
  $graphics.DrawString($title,$small,[System.Drawing.Brushes]::White,20,14)
  $y = 75
  foreach ($line in $lines) {
    $graphics.DrawString($line,$font,[System.Drawing.Brushes]::White,45,$y)
    $y += 42
  }
  $stream = New-Object System.IO.MemoryStream
  try {
    $bitmap.Save($stream,[System.Drawing.Imaging.ImageFormat]::Png)
    $samples = New-Object byte[] 2304
    for ($row = 0; $row -lt 36; $row++) {
      for ($column = 0; $column -lt 64; $column++) {
        $color = $bitmap.GetPixel([int](($column+0.5)*15),[int](($row+0.5)*15))
        $samples[$row*64+$column] = [byte][Math]::Round(($color.R*77+$color.G*150+$color.B*29)/256)
      }
    }
    @{image=[Convert]::ToBase64String($stream.ToArray());samples=[Convert]::ToBase64String($samples)} | ConvertTo-Json -Compress
  } finally { $stream.Dispose() }
} finally {
  $font.Dispose()
  $small.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
}
