const args = process.argv.slice(2)

if (args[0] === '--version') {
  console.log('opencode 1.4.3')
  process.exit(0)
}

if (args[0] === 'run') {
  let session = ''
  let prompt = ''
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] === '--session') {
      session = args[index + 1] || ''
      index += 1
    } else if (args[index] === '--prompt') {
      prompt = args[index + 1] || ''
      index += 1
    } else {
      prompt = args[index]
    }
  }

  if (session === 'ses_e2e_1') {
    if (prompt === 'say exactly CONTINUE_OK and nothing else') {
      console.log('CONTINUE_OK')
    } else {
      console.log(`OpenCode session ${session} continued: ${prompt}`)
    }
    process.exit(0)
  }

  console.error(`Session not found: ${session}`)
  process.exit(1)
}

console.error(`opencode mock: unsupported args: ${args.join(' ')}`)
process.exit(1)
