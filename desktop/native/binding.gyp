{
  "targets": [
    {
      "target_name": "zoia_capture",
      "sources": [ "src/addon.cpp" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "include"
      ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS", "NOMINMAX", "WIN32_LEAN_AND_MEAN" ],
      "libraries": [
        "-ld3d11.lib",
        "-ldxgi.lib",
        "-lwindowsapp.lib"
      ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1,
          "AdditionalOptions": [ "/std:c++17", "/await", "/EHsc" ]
        }
      }
    }
  ]
}
