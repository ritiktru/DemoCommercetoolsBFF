import { Controller, Get, Header } from '@nestjs/common';
import { loginPage, loginScript } from './login-page.js';

@Controller()
export class AppController {
  @Get('health')
  health() { return { status: 'ok' }; }

  @Get('login')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Referrer-Policy', 'no-referrer-when-downgrade')
  login() { return loginPage; }

  @Get('login.js')
  @Header('Content-Type', 'application/javascript; charset=utf-8')
  script() { return loginScript; }
}
