//! App de administracion (Tauri v2). Por ahora expone comandos de demostracion;
//! la integracion real con el backend (aprobaciones, publicacion a GitHub,
//! declaracion de ganador) se conecta en fases posteriores del proyecto.

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
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
        .invoke_handler(tauri::generate_handler![app_version, dashboard_summary])
        .run(tauri::generate_context!())
        .expect("error al ejecutar la aplicacion Tauri");
}
