{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
  packages = with pkgs; [
    git
    nodejs
    cargo
    rustc
    rustfmt
    clippy
    rust-analyzer
    pkg-config
    openssl
    rustup
    prettier
  ] ++ lib.optionals stdenv.isLinux [
    webkitgtk_4_1
    libsoup_3
    gtk3
    glib-networking
    cairo
    gdk-pixbuf
    pango
    atk
    librsvg
    dbus
    libappindicator-gtk3
  ];

  shellHook = ''
    echo "Oyot development shell"
    echo "  Node.js: $(node --version)"
    echo "  npm:     $(npm --version)"
    echo "  Rust:    $(rustc --version)"
    echo "  Cargo:   $(cargo --version)"
    echo ""
    echo "Quick start:  make dev"
    echo "MQTT broker:  make mqtt-up"
    echo "TypeScript:   make check"
    echo "Rust lint:    make clippy"
  '';
}
