//! App de administracion (Tauri v2). Por ahora expone comandos de demostracion;
//! la integracion real con el backend (aprobaciones, publicacion a GitHub,
//! declaracion de ganador) se conecta en fases posteriores del proyecto.

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Abre una URL en el navegador del sistema.
///
/// Solo https: este comando lanza un proceso del sistema, asi que no puede
/// quedar como un abridor de URLs arbitrario (`file:`, `javascript:`...). Sin
/// crate extra: usa el manejador de protocolos del SO. El MSI es solo Windows,
/// pero se dejan las otras ramas por si se compila en dev en otro SO.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("solo se permiten URLs https".into());
    }
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", &url])
        .spawn();
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = std::process::Command::new("xdg-open").arg(&url).spawn();
    r.map(|_| ()).map_err(|e| e.to_string())
}

/// Resumen de estado para el panel (mock hasta conectar el backend).
#[tauri::command]
fn dashboard_summary() -> serde_json::Value {
    serde_json::json!({
        "pendingApprovals": 3,
        "soldToday": 5,
        "backendConnected": false
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![app_version, dashboard_summary, open_external])
        .run(tauri::generate_context!())
        .expect("error al ejecutar la aplicacion Tauri");
}
