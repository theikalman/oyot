// swift-tools-version:5.3

import PackageDescription

let package = Package(
  name: "tauri-plugin-background-sync",
  platforms: [
    .macOS(.v10_13),
    .iOS(.v14),
  ],
  products: [
    .library(
      name: "tauri-plugin-background-sync",
      type: .static,
      targets: ["tauri-plugin-background-sync"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    // The app's Rust library, declared in C so Swift calls it with the C
    // calling convention. Its symbols are resolved when the app is linked.
    .target(
      name: "OyotRust",
      path: "Sources/OyotRust"),
    .target(
      name: "tauri-plugin-background-sync",
      dependencies: [
        .byName(name: "Tauri"),
        .byName(name: "OyotRust"),
      ],
      path: "Sources/BackgroundSyncPlugin"),
  ]
)
