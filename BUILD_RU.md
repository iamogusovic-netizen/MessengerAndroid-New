# Сборочная конфигурация

Используемая связка:
- JDK 17
- Android Gradle Plugin 8.7.3
- Gradle 8.9
- compileSdk 35 / Build Tools 35.0.0
- minSdk 23 / targetSdk 34

GitHub Actions workflow: `.github/workflows/build-apk.yml`.

На runner Gradle 8.9 устанавливается действием `gradle/actions/setup-gradle@v4`, затем выполняется:
`gradle --no-daemon --stacktrace clean assembleDebug`

Результат:
`app/build/outputs/apk/debug/app-debug.apk`

Стандартный Gradle Wrapper не включён: CI workflow не использует `./gradlew` и устанавливает закреплённую версию Gradle самостоятельно. Для локальной сборки нужно установить Gradle 8.9 и Android SDK.
