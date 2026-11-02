use rand::{distributions::Alphanumeric, Rng, RngCore};

fn main() {
    let password: String = rand::thread_rng().sample_iter(&Alphanumeric).take(28).map(char::from).collect();
    let mut pepper = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut pepper);
    println!("ADMIN_PASSWORD={password}");
    println!("CODE_PEPPER={}", hex::encode(pepper));
    println!("\nStore these in server/.env. Back up CODE_PEPPER; changing it invalidates existing registration codes.");
}
