# CoCreateJS

[![npm](https://img.shields.io/npm/v/@cocreate/cocreatejs?style=flat-square)](https://www.npmjs.com/package/@cocreate/cocreatejs)
[![GitHub release](https://img.shields.io/github/v/release/CoCreate-app/CoCreateJS?style=flat-square)](https://github.com/CoCreateJS/CoCreateJS/releases)
[![License](https://img.shields.io/github/license/CoCreate-app/CoCreateJS?style=flat-square)](./LICENSE)

An open-source, modular JavaScript runtime for building realtime, offline-first, data-driven applications with declarative HTML, headless JavaScript, or both.

CoCreateJS gives standard HTML a direct connection to data, actions, APIs, sockets, storage, components, and third-party plugins. Start with a few attributes, use the same capabilities programmatically, or combine them with the framework and architecture you already have.

This repository contains `@cocreate/cocreatejs`, the optional browser-side runtime. It works especially well with [CoCreateWS](https://github.com/CoCreateJS/CoCreateWS), the scalable server runtime behind the wider CoCreate ecosystem, but neither side locks you into the other.

![CoCreateJS](./CoCreateJS.png)

## Build from HTML. Control it from JavaScript. Scale it on CoCreateWS.

CoCreateJS is not a replacement syntax for HTML and it is not a closed application framework. Its attributes are a declarative interface over focused JavaScript modules. The same modules can be used headlessly, extended through plugins, or integrated into an existing application.

```text
Declarative HTML     Headless JavaScript     Existing Frameworks
        \                    |                       /
         \                   |                      /
          +----------- CoCreateJS Client ----------+
                              |
             +----------------+----------------+
             |                                 |
       Local browser state             HTTP + WebSockets
    IndexedDB · cache · PWA                    |
                                                v
                                           CoCreateWS
                              CRUD · APIs · auth · files · realtime
                                                |
                              Databases · services · infrastructure
```

The result is a progressive runtime: a page can begin as ordinary HTML, gain reactive behavior one attribute at a time, and grow into a collaborative application without rewriting its interface around a proprietary component model.

## What the client provides

| Capability | What it enables |
| --- | --- |
| Declarative data | Bind HTML elements to collections, objects, and nested keys |
| Unified CRUD | Create, read, update, delete, filter, and synchronize through one payload convention |
| Realtime sockets | Exchange application messages and receive live data updates over WebSockets |
| Collaborative editing | Synchronize changes, cursors, selections, and CRDT-backed state |
| Offline-first storage | Work with IndexedDB, local storage, cache, queued operations, and PWA behavior |
| Components and rendering | Load HTML sources, render templates, filter collections, and update the DOM |
| Any API | Build provider-neutral requests from HTML or JavaScript while credentials remain on the server |
| Abstract plugins | Load and operate first-party or third-party libraries through a shared AST configuration model |
| Files and media | Upload, download, import, export, and manage files through standard actions |
| Application behavior | Compose actions, validation, conditional logic, calculations, state, and events |
| Lazy loading | Load modules when their selectors appear instead of initializing the entire runtime upfront |

## Declarative data binding

The `array`, `object`, and `key` attributes describe where an element's value lives. The convention works across form controls, text elements, templates, and components.

```html
<input
    array="contacts"
    object="639b39fd138632d1d886ccf5"
    key="profile.name"
    placeholder="Contact name" />

<h1
    array="contacts"
    object="639b39fd138632d1d886ccf5"
    key="profile.name"></h1>
```

Both elements address the same value. CoCreateJS modules can read it, update it, persist it, render it elsewhere, and synchronize it with connected clients.

The HTML remains understandable without the runtime: `array` identifies the dataset, `object` identifies the record, and `key` identifies the value. Dot and bracket notation allow the same convention to describe nested data.

## One CRUD model across local and remote data

The CRUD client uses self-contained payloads instead of database-specific calls. The storage adapter determines where the operation runs, while the application keeps the same object shape.

```js
import crud from "@cocreate/crud-client";

const result = await crud.send({
    method: "object.read",
    array: "contacts",
    storage: ["indexeddb", "mongodb"],
    filter: {
        query: { status: "active" },
        limit: 25,
        sort: { "updated.on": -1 }
    }
});
```

The same protocol supports create, read, update, delete, filtering, pagination, sorting, and multiple storage targets. Local adapters can keep an application responsive offline while remote adapters synchronize shared state when connectivity is available.

This separation keeps UI and business logic independent from a specific database. MongoDB, IndexedDB, SQLite, and additional adapters can participate without giving each one a different application API.

## Realtime and collaborative by design

CoCreateJS treats WebSockets as an application transport rather than a feature tied to one widget. CRUD operations, APIs, user sessions, server events, progress, and collaborative updates can travel through the same communication layer.

The client runtime includes modules for:

- Correlated request and response messages
- Targeted and broadcast socket events
- Live object and collection updates
- CRDT-backed collaborative state
- Shared cursors, selections, and editing presence
- Reconnection and synchronization with local storage

Applications can use the declarative layer or communicate through the socket client directly. The payload remains data, so it can be queued, replayed, authorized, routed, and handled by independent services.

## Connect to any API

The API client turns a form or container into a provider-neutral request surface. An endpoint and HTTP method describe the operation; provider-prefixed keys describe the payload.

```html
<form
    api="stripe"
    stripe-endpoint="create-customer"
    stripe-method="post">
    <input stripe-key="email" type="email" />
    <input
        stripe-key="metadata.workspace"
        value="production"
        hidden />

    <button actions="stripe.create-customer">
        Create customer
    </button>
</form>
```

The client converts the form into structured data using dot and bracket notation. The CoCreate API gateway resolves the configured provider, endpoint, credentials, headers, and workflow on the server. Secret API keys never need to be shipped to the browser.

This is not limited to Stripe or a fixed SDK list. The same interface can drive REST APIs, internal services, server actions, multi-step workflows, and webhooks. Use HTML for declarative integrations or call the API module directly from JavaScript when an application needs imperative control.

## Use third-party libraries as CoCreate plugins

CoCreate Plugins provides an abstract bridge between DOM elements, external JavaScript libraries, and the CoCreate AST. Register a library's JavaScript and CSS resources once, then initialize and operate it from a `plugin` attribute.

```html
<div
    id="calendar"
    plugin='{
        "FullCalendar": {
            "Calendar": [
                "$this",
                {
                    "initialView": "dayGridMonth",
                    "editable": true
                }
            ]
        },
        "FullCalendar.render": []
    }'>
</div>
```

The runtime loads the configured resources, creates the plugin instance on the element, and makes its methods and values available to the same element pipeline used elsewhere in CoCreateJS.

The bundled configuration demonstrates integrations for calendars, charts, maps, editors, uploads, selects, notifications, lightboxes, drag-and-drop, animation, code highlighting, ratings, guided tours, and more. Because the loader targets browser globals and declarative AST operations, applications can add new libraries without adding provider-specific behavior to the core runtime.

## Components, rendering, and application behavior

Load reusable HTML sources directly into semantic elements:

```html
<nav src="/components/navbar.html"></nav>
<main src="/pages/dashboard.html"></main>
<footer src="/components/footer.html"></footer>
```

Then compose behavior with focused attributes and modules:

- `template`, `render`, and filters for collection-driven interfaces
- `actions` for reusable event pipelines
- `show` and `hide` for conditional behavior
- `required`, validation, and unique-value checks for forms
- `calculate` and state for derived values
- file actions for uploads, downloads, imports, and exports
- drag-and-drop, resize, position, modal, notification, and accessibility modules

Each concern remains a separate package. Applications can use the complete CoCreateJS bundle or install only the modules they need.

## Selector-driven lazy loading

The client observes the document and maps selectors to modules. An element with `array` can activate CRUD behavior; a `plugin` attribute can activate the plugin runtime; `show` or `hide` can activate conditional logic; a file input can activate file handling.

Modules are also discovered when matching elements are added later. This makes dynamically loaded pages and components part of the same runtime without requiring every feature to initialize during the first page load.

## Headless and framework-friendly

The declarative layer is optional. CoCreateJS is assembled from focused `@cocreate/*` packages with JavaScript APIs that can be used independently.

Use CoCreateJS in whichever form fits the application:

- A script bundle that enhances existing HTML
- Individual packages imported into a JavaScript application
- A declarative UI backed by headless modules
- A data and realtime layer beneath React, Vue, Svelte, Web Components, or another renderer
- A client for CoCreateWS or a compatible custom backend

The server does not require the CoCreateJS client, and the client does not require a particular UI framework. HTTP, WebSockets, structured payloads, and standard browser APIs remain the boundaries.

## Scale with CoCreateWS

[CoCreateWS](https://github.com/CoCreateJS/CoCreateWS) is the server-side runtime for applications that need the full CoCreate infrastructure model. It brings the client's data, socket, API, file, authentication, and authorization conventions into a modular server environment.

An application can begin with a single deployment and grow into distributed infrastructure without changing how the client describes its data or messages. CoCreateWS is designed for:

- Multi-tenant applications and organization-isolated data
- Realtime WebSocket workloads
- Modular authentication and field-level authorization
- Database-agnostic CRUD routing
- API gateway and webhook execution
- File and storage services
- Worker processes, server coordination, and autoscaling
- Distributed deployments across machines, regions, and infrastructure providers

CoCreateJS remains the browser runtime; CoCreateWS owns server execution and infrastructure. Together they provide an end-to-end system, while their protocol boundaries allow either side to be replaced or used independently.

## Installation

Install the complete client runtime:

```sh
npm install @cocreate/cocreatejs
```

Or with Yarn:

```sh
yarn add @cocreate/cocreatejs
```

Import it as a browser-side dependency:

```js
import "@cocreate/cocreatejs";
```

You can also load a built bundle directly:

```html
<script src="/dist/CoCreate.js"></script>
```

## Development

Clone the repository and install its dependencies:

```sh
git clone https://github.com/CoCreateJS/CoCreateJS.git
cd CoCreateJS
npm install
```

Start the development watcher:

```sh
npm run dev
```

Create a production build:

```sh
npm run build
```

The generated browser bundle is written to `src/dist`.

## Documentation and examples

- [CoCreateJS website](https://cocreatejs.com/)
- [CoCreateJS documentation](https://cocreatejs.com/docs/)
- [Repository documentation](./docs/)
- [Demo source](./demo/)
- [CoCreateWS](https://github.com/CoCreateJS/CoCreateWS)
- [Changelog](./CHANGELOG.md)
- [Releases](https://github.com/CoCreateJS/CoCreateJS/releases)

## Contributing

CoCreateJS is built as an ecosystem of small, composable packages. Contributions to the runtime, individual modules, documentation, and examples are welcome.

Read the [contribution guide](./CONTRIBUTING.md), then open an [issue](https://github.com/CoCreateJS/CoCreateJS/issues) or [pull request](https://github.com/CoCreateJS/CoCreateJS/pulls).

## License

CoCreateJS is licensed under the [GNU Affero General Public License v3.0](./LICENSE). Alternative commercial licensing may also be available for teams that need different terms.

For licensing or project questions, contact [info@cocreatejs.com](mailto:info@cocreatejs.com).
