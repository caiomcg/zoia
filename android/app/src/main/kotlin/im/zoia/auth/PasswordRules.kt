package im.zoia.auth

/**
 * What a password needs. Must match `isValidPassword` in
 * server/src/accounts.js, which is what decides: this is so the app can say
 * what is missing while someone types, rather than after a refusal.
 */
object PasswordRules {
    const val MIN_LENGTH = 6

    enum class Rule(val label: String, val check: (String) -> Boolean) {
        LENGTH("Pelo menos $MIN_LENGTH caracteres", { it.length >= MIN_LENGTH }),
        UPPER("Uma letra maiúscula", { p -> p.any { it.isUpperCase() } }),
        LOWER("Uma letra minúscula", { p -> p.any { it.isLowerCase() } }),
        DIGIT("Um número", { p -> p.any { it.isDigit() } }),
        SYMBOL("Um símbolo", { p -> p.any { !it.isLetterOrDigit() } }),
    }

    fun isStrong(password: String): Boolean = Rule.entries.all { it.check(password) }
}
