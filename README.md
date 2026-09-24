# PrintNexus

**One Dashboard, All Printers.**

PrintNexus is a centralized 3D printer fleet monitoring and management system developed within the **SASA Industry 4.0** environment.

The system brings together **20 3D printers from 5 different brands** under a single interface, providing printer monitoring, remote control, live camera streaming, analytics, production records, and cost tracking.

> This project was developed as part of a summer internship during **July–August 2026**.
> The project was previously named **PrintHQ**; some legacy references may still exist in the source code and file structure.

---

## Overview

PrintNexus was developed to provide a centralized interface for managing a heterogeneous 3D printer fleet.

Instead of managing printers through separate manufacturer-specific interfaces, PrintNexus provides a unified dashboard for:

* Real-time printer status monitoring
* Temperature and print progress tracking
* Remote printer control
* Live camera streaming
* Production and cost tracking
* Analytics and reporting
* Role-based access control

The system uses a modular **adapter architecture**, allowing different printer brands and communication protocols to be integrated into a common backend structure.

---

## Features

* **20 3D printers from 5 brands** managed through a single dashboard
* **Real-time updates** using WebSocket communication
* **Remote printer control** where supported by the printer API
* **Live camera streaming** using different streaming methods depending on the printer
* **Role-Based Access Control (RBAC)** with `admin`, `operator`, and `viewer` roles
* **Analytics and reporting** for printer and production data
* **Production and cost management** including filament, electricity, and labor costs
* **SQLite database** for application and telemetry data
* **Electron desktop application** for standalone usage
* **Dark / light theme**
* **Excel and CSV export** for collected data

---

## Supported Printer Fleet

| Brand             | Quantity | Communication |
| ----------------- | -------: | ------------- |
| Bambu Lab         |        9 | MQTT / MQTTS  |
| ZAXE              |        4 | WebSocket     |
| Ultimaker         |        2 | HTTP / REST   |
| Raise3D           |        4 | HTTP / REST   |
| FlashForge Guider |        1 | TCP Socket    |
| **Total**         |   **20** |               |

Printer-specific communication is handled through dedicated adapters under the `adapters/` directory.

---

## Architecture

```text
                         ┌───────────────────────┐
                         │   Physical Printers   │
                         │   5 Brands / 20 Units │
                         └───────────┬───────────┘
                                     │
                        MQTT / WS / HTTP / TCP
                                     │
                                     ▼
┌────────────────────────────────────────────────────────┐
│                       server.js                         │
│                                                        │
│  Express API │ WebSocket │ RBAC │ Camera Streaming    │
│  Production & Cost Management                          │
└──────────────────────────┬─────────────────────────────┘
                           │
                 ┌─────────┴─────────┐
                 │                   │
                 ▼                   ▼
        ┌────────────────┐   ┌─────────────────┐
        │    adapters/   │   │   database.js   │
        │                │   │                 │
        │ Bambu          │   │ SQLite          │
        │ ZAXE           │   │ Telemetry       │
        │ Ultimaker      │   │ Events          │
        │ Raise3D        │   │ Production      │
        │ Guider         │   │ Records         │
        └────────────────┘   └─────────────────┘
                           │
                           ▼
                 ┌────────────────────┐
                 │      Frontend      │
                 │                    │
                 │ HTML / CSS / JS    │
                 │ WebSocket + REST   │
                 └────────────────────┘
```

The backend creates the appropriate printer adapter based on the printer configuration. Each adapter implements a common interface, allowing the main server to communicate with different printer brands without depending on their individual protocols.

---

## Technology Stack

| Layer                   | Technology                      |
| ----------------------- | ------------------------------- |
| Backend                 | Node.js, Express.js             |
| Database                | SQLite, better-sqlite3          |
| Authentication          | JSON Web Token (JWT)            |
| Real-time Communication | WebSocket (`ws`)                |
| Printer Communication   | MQTT, WebSocket, HTTP/REST, TCP |
| Camera Streaming        | FFmpeg, HLS, MJPEG              |
| Frontend                | HTML, CSS, Vanilla JavaScript   |
| Charts                  | Chart.js                        |
| Icons                   | Lucide Icons                    |
| File Export             | XLSX                            |
| File Upload             | Multer                          |
| Desktop Application     | Electron.js                     |

---

## Project Structure

```text
PrintNexus/
├── adapters/              # Printer-specific adapters
├── assets/                # Project assets
├── electron/              # Electron desktop application
├── public/                # Frontend files
├── database.js            # SQLite database layer
├── printers.json          # Printer configuration
├── server.js              # Main backend server
├── package.json
├── package-lock.json
├── .gitignore
└── PrintNexus.md          # Detailed technical documentation
```

---

## Getting Started

### Requirements

* Node.js 18+
* npm
* Network access to the printer network
* Printer-specific credentials/configuration

### Installation

Clone the repository and install the dependencies:

```bash
npm install
```

Create a `.env` file in the project root and configure the required environment variables.

Then start the application:

```bash
npm start
```

The server runs on:

```text
http://localhost:3000
```

### Electron

The project can also be launched as a desktop application:

```bash
npm run dev
```

Windows packaging is available through:

```bash
npm run build:win
```

> The `.env` file contains environment-specific configuration and credentials and is intentionally excluded from the repository.

---

## Configuration

Printer configuration is stored in `printers.json`.

Sensitive values such as IP addresses, passwords, access codes, and tokens are represented using environment-variable placeholders rather than hard-coded credentials.

Example:

```json
{
  "ip": "${PRINTER_IP}",
  "username": "${PRINTER_USER}",
  "password": "${PRINTER_PASS}"
}
```

Actual environment-specific values should be provided through `.env`.

---

## Documentation

For detailed technical information about the system, including:

* API endpoints
* Database schema
* Authentication and RBAC
* Camera streaming architecture
* Frontend pages
* Production and cost management
* Electron architecture
* Troubleshooting
* Security notes
* Development notes

see the full project documentation:

**[PrintNexus.md](./PrintNexus.md)**

---

## Internship Project

PrintNexus was developed during a summer internship at **SASA** as a collaborative project between two interns.

The project was developed within the **SASA Industry 4.0** context and involved the integration of multiple 3D printer brands, communication protocols, monitoring systems, camera streaming, data management, and desktop application technologies.

---

## License & Copyright

This project was developed during an internship at **SASA** in collaboration with a teammate.

**All rights to this project and its related source code, documentation, design, and project materials belong to SASA.**

Unauthorized copying, modification, distribution, reproduction, or use of this project or any part of it is prohibited without prior written permission from SASA.

This repository does not grant any open-source license or permission to use the project materials.

---
