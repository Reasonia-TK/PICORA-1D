// ES-Sim から抽出した1D専用シェル。バックエンドはアプリと一緒に起動・終了する。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{TcpListener, TcpStream};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::Manager;

struct Backend {
    port: Result<u16, String>,
    child: Mutex<Option<Child>>,
}

#[tauri::command]
fn backend_port(backend: tauri::State<'_, Backend>) -> Result<u16, String> {
    backend.port.clone()
}

fn start_backend(app: &tauri::App) -> Result<(u16, Option<Child>), String> {
    let mut command;
    let port;
    if cfg!(debug_assertions) {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../backend");
        // start.ps1 等で起動済みならそのサーバーを使う。別アプリのサーバーは受け付けない。
        if let Ok(mut stream) = TcpStream::connect_timeout(
            &"127.0.0.1:8321".parse().unwrap(), std::time::Duration::from_millis(150),
        ) {
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(2)));
            let _ = stream.write_all(b"GET /health HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n");
            let mut reply = String::new();
            let _ = stream.read_to_string(&mut reply);
            if reply.contains("PICORA-1D") {
                return Ok((8321, None));
            }
            return Err("ポート8321が別のアプリに使用されています。終了してから再起動してください。".into());
        }
        let python = root.join(if cfg!(windows) { ".venv/Scripts/python.exe" } else { ".venv/bin/python" });
        if !python.is_file() {
            return Err("Python環境がありません。scripts/setup.ps1 を実行してください。".into());
        }
        port = 8321;
        command = Command::new(python);
        command.current_dir(root).args(["-m", "uvicorn", "es_sim.server:app", "--host", "127.0.0.1", "--port", &port.to_string()]);
    } else {
        port = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?
            .local_addr().map_err(|e| e.to_string())?.port();
        let exe = app.path().resource_dir().map_err(|e| e.to_string())?
            .join("backend").join(if cfg!(windows) { "picora-backend.exe" } else { "picora-backend" });
        if !exe.is_file() {
            return Err(format!("同梱バックエンドが見つかりません: {}", exe.display()));
        }
        command = Command::new(exe);
        command.args(["--port", &port.to_string()]);
    }
    if let Ok(config) = app.path().app_log_dir() {
        let _ = std::fs::create_dir_all(&config);
        if let Ok(log) = std::fs::File::create(config.join("backend.log")) {
            if let Ok(stderr) = log.try_clone() {
                command.stdout(Stdio::from(log)).stderr(Stdio::from(stderr));
            }
        }
    }
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let child = command.spawn().map_err(|e| format!("バックエンドの起動に失敗しました: {e}"))?;
    Ok((port, Some(child)))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![backend_port])
        .setup(|app| {
            let (port, child) = match start_backend(app) {
                Ok((port, child)) => (Ok(port), child),
                Err(error) => (Err(error), None),
            };
            app.manage(Backend { port, child: Mutex::new(child) });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("PICORA-1D を構築できませんでした")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(mut child) = app.state::<Backend>().child.lock().unwrap().take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}
