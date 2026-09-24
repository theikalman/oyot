package com.ajiyakin.oyot.signin

import android.accounts.Account
import android.app.Activity
import androidx.activity.result.ActivityResult
import androidx.activity.result.IntentSenderRequest
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.AuthorizationResult
import com.google.android.gms.auth.api.identity.ClearTokenRequest
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.common.api.Scope

@InvokeArg
class AuthorizeArgs {
    lateinit var scope: String
    var account: String? = null
    var interactive: Boolean = false
}

@InvokeArg
class ClearTokenArgs {
    lateinit var token: String
}

/**
 * Google Play services' authorization, for backing up to Google Drive.
 *
 * Play services asks the user once, keeps the grant, and from then on hands
 * out short-lived access tokens without asking again. No refresh token ever
 * reaches the app. What this returns goes to Rust, never to the webview.
 */
@TauriPlugin
class SignInPlugin(private val activity: Activity) : Plugin(activity) {

    @Command
    fun authorize(invoke: Invoke) {
        val args = invoke.parseArgs(AuthorizeArgs::class.java)
        val availability = GoogleApiAvailability.getInstance()
        if (availability.isGooglePlayServicesAvailable(activity) != ConnectionResult.SUCCESS) {
            invoke.reject(
                "Google Play services is not available on this device",
                "unavailable"
            )
            return
        }

        val builder = AuthorizationRequest.builder()
            .setRequestedScopes(listOf(Scope(args.scope)))
        val account = args.account
        if (account != null) {
            // The account linked before, so a device with several Google
            // accounts keeps using the one the user chose.
            builder.setAccount(Account(account, "com.google"))
        } else if (args.interactive) {
            // Linking: always let the user choose. Play services would
            // otherwise reuse the account an earlier link chose, even after
            // unlinking, and nobody could switch to another.
            builder.setPrompt(AuthorizationRequest.Prompt.SELECT_ACCOUNT)
        }

        Identity.getAuthorizationClient(activity)
            .authorize(builder.build())
            .addOnSuccessListener { result ->
                val pending = result.pendingIntent
                if (result.hasResolution() && pending != null) {
                    if (!args.interactive) {
                        invoke.reject("Google needs you to confirm access again", "needs-user")
                        return@addOnSuccessListener
                    }
                    val request = IntentSenderRequest.Builder(pending.intentSender).build()
                    startIntentSenderForResult(invoke, request, "authorized")
                } else {
                    answer(invoke, result)
                }
            }
            .addOnFailureListener { e -> fail(invoke, e) }
    }

    @ActivityCallback
    fun authorized(invoke: Invoke, result: ActivityResult) {
        // The outcome is in the Intent, not the result code: a failure can
        // come back as "cancelled" with its reason inside. Only nothing at
        // all is taken as the user backing out; a reason is reported, and a
        // cancel read from it is still a quiet cancel.
        val data = result.data
        if (data == null) {
            invoke.reject("the sign-in was cancelled", "cancelled")
            return
        }
        try {
            val granted = Identity.getAuthorizationClient(activity)
                .getAuthorizationResultFromIntent(data)
            answer(invoke, granted)
        } catch (e: ApiException) {
            fail(invoke, e)
        }
    }

    @Command
    fun clearToken(invoke: Invoke) {
        val args = invoke.parseArgs(ClearTokenArgs::class.java)
        val request = ClearTokenRequest.builder().setToken(args.token).build()
        Identity.getAuthorizationClient(activity)
            .clearToken(request)
            .addOnSuccessListener { invoke.resolve() }
            .addOnFailureListener { e -> fail(invoke, e) }
    }

    private fun answer(invoke: Invoke, result: AuthorizationResult) {
        val token = result.accessToken
        if (token == null) {
            invoke.reject("Google granted no access", "failed")
            return
        }
        val granted = JSObject()
        granted.put("accessToken", token)
        granted.put("grantedScopes", JSArray(result.grantedScopes))
        invoke.resolve(granted)
    }

    private fun fail(invoke: Invoke, e: Exception) {
        val status = (e as? ApiException)?.statusCode
        when (status) {
            CommonStatusCodes.CANCELED -> invoke.reject("the sign-in was cancelled", "cancelled")
            // The package name and signing certificate match no Android
            // client in the Google Cloud project.
            CommonStatusCodes.DEVELOPER_ERROR -> invoke.reject(
                "this build of Oyot is not registered with Google",
                "failed"
            )
            CommonStatusCodes.NETWORK_ERROR -> invoke.reject("could not reach Google", "failed")
            else -> invoke.reject(e.message ?: "Google Play services refused", "failed")
        }
    }
}
