#!/usr/bin/env node
import 'dotenv/config';
import { installLettaClientValidationFilter } from './app/letta/LettaClientValidationFilter.js';

// Install before loading application composition and booting the engine.
installLettaClientValidationFilter();
await import('./app/main.js');
