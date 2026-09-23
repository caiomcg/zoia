{
  "targets": [
    {
      "target_name": "zoia_capture",
      "sources": [ "src/addon.cpp" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "include"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "NOMINMAX",
        "WIN32_LEAN_AND_MEAN",
        # Belt and braces. Nothing here should reach <experimental/coroutine>
        # under C++20, but if a C++/WinRT header ever does, this keeps it a
        # warning rather than the hard error that broke the first release.
        "_SILENCE_EXPERIMENTAL_COROUTINE_DEPRECATION_WARNINGS"
      ],
      "libraries": [
        "-ld3d11.lib",
        "-ldxgi.lib",
        "-lwindowsapp.lib"
      ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1,
          # C++20 rather than C++17 plus /await. The first CI release failed
          # here: MSVC 14.51 on the runner turns <experimental/coroutine> into
          # a hard error (STL1011), and /await is what drags it in. Nothing in
          # addon.cpp actually uses coroutines — no co_await, no co_return — so
          # the flag was buying an obsolete header for nothing. C++20 is also
          # what C++/WinRT wants, and where standard <coroutine> lives if a
          # future change does need one.
          "AdditionalOptions": [ "/std:c++20", "/EHsc" ]
        }
      }
    }
  ]
}
