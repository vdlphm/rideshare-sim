import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

@Injectable()
class GreeterService {
  greet(name: string): string {
    return `hello ${name}`;
  }
}

@Injectable()
class WelcomeService {
  constructor(private readonly greeter: GreeterService) {}

  welcome(name: string): string {
    return this.greeter.greet(name);
  }
}

describe('Nest DI under Vitest + SWC', () => {
  it('injects a service through the constructor via decorator metadata', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [GreeterService, WelcomeService],
    }).compile();

    const welcome = moduleRef.get(WelcomeService);
    expect(welcome.welcome('rider')).toBe('hello rider');
  });
});
