' Arranca la app del gimnasio sin ventana al iniciar Windows (ver launcher.py).
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """D:\gimnasio_app\.venv\Scripts\pythonw.exe"" ""D:\gimnasio_app\launcher.py""", 0, False
