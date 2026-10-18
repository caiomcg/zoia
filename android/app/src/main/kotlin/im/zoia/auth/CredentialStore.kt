package im.zoia.auth

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

class CredentialStore(context: Context) {
    private val masterKey = MasterKey.Builder(context)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()

    private val prefs = EncryptedSharedPreferences.create(
        context,
        PREFS_NAME,
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )

    private val plainPrefs = context.getSharedPreferences("zoia_settings", Context.MODE_PRIVATE)

    /**
     * What a sign-in leaves behind: the server and this machine's credential,
     * so the password is typed once per device. The server is also kept in
     * the clear, to start the sign-in screen with after signing out.
     */
    fun saveSignIn(serverUrl: String, deviceCredential: String, deviceName: String) {
        prefs.edit()
            .putString(KEY_SERVER_URL, serverUrl)
            .putString(KEY_DEVICE_CREDENTIAL, deviceCredential)
            .putString(KEY_DEVICE_NAME, deviceName)
            .apply()
        plainPrefs.edit()
            .putString(KEY_LAST_NAME, deviceName)
            .putString(KEY_LAST_SERVER, serverUrl)
            .apply()
    }

    /** The server last signed in to, for the sign-in screen to start with. */
    fun getLastServerUrl(): String? = plainPrefs.getString(KEY_LAST_SERVER, null)

    fun saveDeviceName(deviceName: String) {
        prefs.edit().putString(KEY_DEVICE_NAME, deviceName).apply()
        plainPrefs.edit().putString(KEY_LAST_NAME, deviceName).apply()
    }

    fun getServerUrl(): String? = prefs.getString(KEY_SERVER_URL, null)

    fun getDeviceCredential(): String? = prefs.getString(KEY_DEVICE_CREDENTIAL, null)

    fun getDeviceName(): String? = prefs.getString(KEY_DEVICE_NAME, null) ?: plainPrefs.getString(KEY_LAST_NAME, null)

    fun getLastDisplayName(): String? = plainPrefs.getString(KEY_LAST_NAME, null)

    fun hasCredential(): Boolean = !getDeviceCredential().isNullOrEmpty() && !getServerUrl().isNullOrEmpty()

    fun clear() {
        prefs.edit()
            .remove(KEY_SERVER_URL)
            .remove(KEY_DEVICE_CREDENTIAL)
            .remove(KEY_DEVICE_NAME)
            .apply()
    }

    companion object {
        private const val PREFS_NAME = "zoia_secure_credentials"
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_DEVICE_CREDENTIAL = "device_credential"
        private const val KEY_DEVICE_NAME = "device_name"
        private const val KEY_LAST_NAME = "last_display_name"
        private const val KEY_LAST_SERVER = "last_server_url"
    }
}
