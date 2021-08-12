> forked from google [perfetto](https://github.com/google/perfetto)

### How to publish npm package

https://www.npmjs.com/package/@pinpoint-apm/perfetto-ui

if there are any changes, modify version & file list before publish
> fix this file `ui/config/deploy/package.json`

build project
```
tools/install-build-deps --ui
```

build ui 
```
ui/build
```

go to dist_version directory
```
cd ui/out/dist_version
```

npm publish (authority of pinpoint-apm organization needed)
```
npm publish
```



<br>
------
<br>

# Perfetto - System profiling, app tracing and trace analysis

Perfetto is a production-grade open-source stack for performance
instrumentation and trace analysis. It offers services and libraries and for
recording system-level and app-level traces, native + java heap profiling, a
library for analyzing traces using SQL and a web-based UI to visualize and
explore multi-GB traces.

See https://perfetto.dev/docs or the /docs/ directory for documentation.
