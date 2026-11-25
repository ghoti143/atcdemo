use tokio::net::TcpListener;

const BIND_ADDR: &str = "0.0.0.0:8080";

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let listener = TcpListener::bind(BIND_ADDR).await?;
    println!(
        "atc-server listening on {BIND_ADDR} (protocol v{})",
        atc_core::PROTOCOL_VERSION
    );
    axum::serve(listener, atc_server::app()).await
}
