@echo off
REM — заходимо в папку проєкту (шлях у лапках!) —
cd /d C:\Users\bodea\OneDrive\Документи\banobox_project
if errorlevel 1 (
  echo Помилка: папку не знайдено!
  echo Перевір правильність шляху.
  pause
  exit /b 1
)

REM — (опційно) ставимо залежності, якщо треба —
npm install

REM — запускаємо сервер —
npm start

REM — щоб залишити вікно відкритим і бачити логи —
pause
