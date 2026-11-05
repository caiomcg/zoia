package im.zoia.api

import kotlinx.serialization.Serializable

@Serializable
data class AdminAccount(
    val id: String,
    val email: String,
    val name: String,
    val role: String,
    val status: String,
    val createdAt: String,
    val lastSeen: String? = null,
    val signupIp: String? = null,
    val devices: Int = 0,
    val avatar: String? = null,
    val avatarIdentity: String? = null
)

@Serializable
data class AdminAccountsResponse(
    val accounts: List<AdminAccount>
)

@Serializable
data class IssuedResetCode(
    val code: String? = null,
    val expiresAt: String? = null
)

@Serializable
data class AdminRoleRequest(
    val role: String
)

@Serializable
data class AvatarResponse(
    val ok: Boolean = true,
    val avatar: String
)
