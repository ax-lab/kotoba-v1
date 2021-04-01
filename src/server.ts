/**
 * @file Entry points for the backend server.
 */

import path from 'path'

import express from 'express'

import { version } from './lib'

/** Server listening port */
const PORT = 8086

const app = express()

// Serve the static files from the `app` subdirectory. This directory is
// generated by the build process and contains the compilation output for the
// web application.
//
// Note that this is not used during development, as we use the webpack server
// to provide those and proxy the backend through webpack.
const WEB = path.join(path.dirname(__filename), 'app')
app.use(express.static(WEB))

app.get('/api', (req, res) => {
	res.json({ app: 'Kotoba', version: version() })
})

/** Handle any unmatched request as the index (we need this for routes to work) */
app.get('*', (req, res) => {
	res.sendFile(path.join(WEB, 'index.html'))
})

/** Entry point to spin-up the server. */
export function start_server() {
	app.listen(PORT, () => {
		console.log(`Server listening on http://localhost:${PORT}/`)
	})
}
