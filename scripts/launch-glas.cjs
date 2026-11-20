#!/usr/bin/env node

const { spawn } = require('node:child_process')
const { join } = require('node:path')

const python = process.env.GLAS_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
const child = spawn(python, [join(__dirname, 'with-glas.py'), ...process.argv.slice(2)], {
  stdio: 'inherit',
})

child.on('error', error => {
  console.error(`Could not start the GLAS launcher: ${error.message}`)
  process.exitCode = 1
})
child.on('close', code => { process.exitCode = code ?? 1 })
