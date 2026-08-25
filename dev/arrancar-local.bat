@echo off
REM ESCANER DE AURA corriendo en esta PC -> https://casa.auratester.com
REM
REM ESTO ES LA SALIDA DE EMERGENCIA, no el sitio. auratester.com lo sirve
REM Cloudflare Pages. Esto se levanta solo cuando se acaba la cuota diaria de
REM Durable Objects y la cola y las salas contestan 500.
REM
REM Tres ventanas, en este orden:
REM   1) el worker (salas y cola), 2) el sitio + reparto de trafico, 3) el tunel.
REM Cerrar cualquiera de las tres tira el sitio abajo.
REM
REM Si cambiaste el codigo del cliente, antes de arrancar hay que recompilar:
REM   npm run build:local

cd /d "%~dp0.."

start "aura - worker"  cmd /k "cd worker && npx wrangler dev --port 8787"
timeout /t 8 /nobreak >nul
start "aura - sitio"   cmd /k "node dev\servidor-local.mjs"
timeout /t 2 /nobreak >nul
start "aura - tunel"   cmd /k ""C:\Program Files (x86)\cloudflared\cloudflared.exe" --config "C:\Users\Pc\.cloudflared\auratester.yml" tunnel run"

echo.
echo Listo. En un minuto: https://casa.auratester.com
echo Para bajarlo, cerra las tres ventanas.
echo.
pause
