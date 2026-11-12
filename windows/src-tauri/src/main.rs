// vufh runs without a console window: Tofu is the whole UI.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    vufh_lib::run()
}
