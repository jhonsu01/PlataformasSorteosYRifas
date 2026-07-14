// Evita abrir una consola en Windows en modo release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    sorteos_rifas_admin_lib::run()
}
