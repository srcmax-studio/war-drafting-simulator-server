# war-drafting-simulator-server
Server software for [WDS](https://wds.srcmax.com).

## System Requirements
- Node.js > 20

## Setup
Make sure to clone with the characters data submodule:
```bash
git clone --recurse-submodules git@github.com:srcmax-studio/war-drafting-simulator-server.git
```
Create configuration file from template. Edit it afterward.
```bash
cp config/server.example.json config/server.json
```
Install the dependencies:
```bash
npm install
```
Start the server:
```bash
npm run start
```

## Configuration

| Parameter          | Description                                                                                                  | Default                              |
|--------------------|--------------------------------------------------------------------------------------------------------------|--------------------------------------|
| `host`             | Server bind address                                                                                          | `0.0.0.0`                            |
| `port`             | Port server listens on                                                                                       | `3001`                               |
| `title`            | Server title                                                                                                 | `WDS Game`                           |
| `owner`            | Server owner                                                                                                 | `SrcMax Studio`                      |
| `tls`              | Enable TLS for WebSocket server. Required when using HTTPS in web client or modern browsers will not connect | `true`                               |
| `private-key`      | Path to your private key                                                                                     | `/path/to/privkey.pem`               |
| `certificate`      | Path to your certificate                                                                                     | `/path/to/fullchain.pem`             |
| `publish-server`   | List your server on the public server list                                                                   | `true`                               |
| `publish-endpoint` | Server list endpoint to publish                                                                              | `https://wds.srcmax.com/api/publish` |
| `publish-ip`       | The public IP address of your server to be connected to                                                      | `public.wds.srcmax.com`              |
| `password`         | Password for joining (empty for no password)                                                                 | `""`                                 |
| `debug`            | Enable debug logging                                                                                         | `false`                              |

## License
This project is licensed under MIT.

```text
Copyright 2025 SrcMax Studio

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

```
