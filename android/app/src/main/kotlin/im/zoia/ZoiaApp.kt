package im.zoia

import android.app.Application
import im.zoia.api.ZoiaApiClient
import im.zoia.auth.CredentialStore
import im.zoia.auth.SessionManager
import im.zoia.livekit.LiveKitRoomManager
import io.livekit.android.LiveKit

class ZoiaApp : Application() {
    lateinit var credentialStore: CredentialStore private set
    lateinit var apiClient: ZoiaApiClient private set
    lateinit var sessionManager: SessionManager private set
    lateinit var roomManager: LiveKitRoomManager private set

    override fun onCreate() {
        super.onCreate()
        instance = this

        // Initialize LiveKit WebRTC engine
        LiveKit.init(this)

        credentialStore = CredentialStore(this)
        apiClient = ZoiaApiClient(credentialStore)
        sessionManager = SessionManager(apiClient, credentialStore)
        roomManager = LiveKitRoomManager(this, apiClient)
    }

    companion object {
        lateinit var instance: ZoiaApp private set
    }
}
