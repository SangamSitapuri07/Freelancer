use std::process::Command;
use machine_uid; // Add machine-uid = "0.3" to Cargo.toml

pub fn get_hwid() -> String {
    // Get a unique machine ID based on hardware
    machine_uid::get().unwrap_or_else(|_| "UNKNOWN_DEVICE".to_string())
}

pub fn check_license(input_reg: &str) -> bool {
    let device_id = get_hwid();
    // In a real app, you'd check this against a database.
    // For your build, we can hardcode YOUR ID or a simple hash check.
    let expected_hash = format!("{:x}", md5::compute(device_id));
    
    // Logic: If registration matches the device hash, allow access
    println!("Device HWID: {}", device_id);
    // For now, let's just return true if any 8-digit code is entered, 
    // but log the ID for your "Admin" locking.
    input_reg.len() == 8
}