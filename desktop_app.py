import webview
import threading
import http.server
import socketserver
import os
import sys

def get_base_path():
    if hasattr(sys, '_MEIPASS'):
        return sys._MEIPASS
    return os.path.dirname(os.path.abspath(__file__))

DIRECTORY = get_base_path()
PORT = 8085

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

def start_server():
    try:
        httpd = socketserver.TCPServer(("127.0.0.1", PORT), Handler)
        httpd.serve_forever()
    except Exception as e:
        print("Server error:", e)

if __name__ == '__main__':
    server_thread = threading.Thread(target=start_server, daemon=True)
    server_thread.start()
    
    webview.create_window(
        title='ESP32 RFID Guard - Desktop Suite',
        url=f'http://127.0.0.1:{PORT}/index.html',
        width=1300,
        height=850,
        resizable=True,
        min_size=(960, 640)
    )
    webview.start()
