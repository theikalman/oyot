# Called from Rust by name, and calling into it by name: R8 must leave the
# native methods and the class that holds them as they are.
-keep class com.ajiyakin.oyot.backgroundsync.Native {
    native <methods>;
}
