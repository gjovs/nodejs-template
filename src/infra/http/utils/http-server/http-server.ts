import { readdirSync } from 'fs';
import server, { Server } from 'http';
import { AddressInfo } from 'net';
import { resolve } from 'path';
import express, {
  Express,
  NextFunction,
  Request,
  Response,
  Router
} from 'express';

import {
  convertCamelCaseKeysToSnakeCase,
  convertSnakeCaseKeysToCamelCase,
  logger
} from '@/util';
import { Controller, Middleware } from '@/presentation/protocols';

import { Route } from './route';
import { Callback, ExpressRoute, RouteMiddleware } from './types';
import { WebSocketServer } from '../websocket-server/websocket-server';
import { WebSocketServerOptions } from '../websocket-server';

const SHARED_STATE_SYMBOL = Symbol('SharedState');

export class HttpServer {
  private express!: Express;
  private server!: Server;
  private startWebSocketServer: boolean = false;
  private websocketServer!: WebSocketServer;
  private websocketServerOptions?: WebSocketServerOptions;
  private listenerOptions!: { port: number; callback: Callback };
  private baseUrl = '';
  private addressInfo!: AddressInfo | null | string;
  private routers: {
    path?: string;
    baseUrl?: string;
    router: Router;
    loaded: boolean;
    hidden: boolean;
  }[] = [];

  private startupCallbacks: Function[] = [];

  private isStarted = false;

  private static instance: HttpServer;

  constructor() {
    this.express = express();
    this.express.use(this.makeSharedStateInitializer());
  }

  public setWebSocketServerOptions(options?: WebSocketServerOptions) {
    this.websocketServerOptions = options;
    this.startWebSocketServer = true;
  }

  public static getInstance(): HttpServer {
    if (!HttpServer.instance) {
      HttpServer.instance = new HttpServer();
    }

    return HttpServer.instance;
  }

  public address() {
    return this?.addressInfo;
  }

  private async initializeWebSocketServer() {
    if (!this.startWebSocketServer) return;

    this.websocketServer = WebSocketServer.getInstance(
      this.getHttpServerInstance(),
      this.websocketServerOptions
    );

    await this.websocketServer.eventsDirectory('src/main/events');
  }

  public listen(port: number | string, callback: () => void = () => {}) {
    if (this.isStarted) return;
    this.isStarted = true;

    this.loadRoutes();

    this.listenerOptions = { callback, port: +port };
    this.server = this.getServer();
    this.server.listen(port, callback);
    this.addressInfo = this.server.address();

    return this.server;
  }

  public getServer(): Server {
    this.loadRoutes();
    return server.createServer(this.express);
  }

  public getHttpServerInstance() {
    return this.server;
  }

  public async listenAsync(
    port: number | string,
    callback: () => void = () => {}
  ) {
    if (this.isStarted) return;
    this.isStarted = true;

    const promises = this.startupCallbacks.map(
      async (callback) => callback?.()
    );

    await Promise.all(promises);

    this.loadRoutes();

    this.listenerOptions = { callback, port: +port };
    this.server = server.createServer(this.express);

    await this.initializeWebSocketServer();

    this.websocketServer.connect();

    this.server.listen(port, callback);

    this.addressInfo = this.server.address();

    return this.server;
  }

  public onStart(callback: Callback, ...callbacks: Callback[]): void;
  public onStart(callback: Callback): void;
  public onStart(callbacks: Callback[]): void;
  public onStart(
    callback: Callback[] | Callback,
    ...callbacks: Callback[]
  ): void {
    const callbackList = Array.isArray(callback)
      ? callback
      : [callback, ...callbacks];

    this.startupCallbacks = callbackList;
  }

  public refresh() {
    if (!this.isStarted) return;
    this.server.close(() => {
      logger.log({ level: 'info', message: 'Refreshing server' });
    });

    this.listen(this.listenerOptions.port, this.listenerOptions.callback);
  }

  public close() {
    if (!this.isStarted) return;
    this.server.close(() => {
      logger.log({ level: 'info', message: 'Shutting down server' });
    });
    if (!this.startWebSocketServer) return;
    this.websocketServer.close();
  }

  public use(
    value: string | RouteMiddleware | ExpressRoute | Function,
    ...middlewares: RouteMiddleware[] | ExpressRoute[]
  ) {
    if (typeof value === 'string') {
      this.express.use(value, ...this.adaptMiddlewares(middlewares));
      return;
    }

    this.express.use(...this.adaptMiddlewares([value, ...middlewares]));
  }
  // FIXME: NEED TO FIX STATE AS GLOBAL VARIABLE
  // public setSharedState<T>(state: T): void {
  //   this.express.use(this.makeSharedStateChanger(state));
  // }

  public set(setting: string, val: any) {
    this.express.set(setting, val);
  }

  public setBaseUrl(url: string) {
    if (this.isStarted) {
      logger.log({
        level: 'warn',
        message: 'Only set the default base url if the server is not started'
      });

      return;
    }
    this.baseUrl = url;
  }

  public async routesDirectory(
    path: string,
    route?: Route,
    ...middlewares: RouteMiddleware[] | ExpressRoute[] | Function[]
  ): Promise<void>;
  public async routesDirectory(
    path: string,
    baseUrl?: string,
    ...middlewares: RouteMiddleware[] | ExpressRoute[] | Function[]
  ): Promise<void>;
  public async routesDirectory(
    path: string,
    middleware?: RouteMiddleware | ExpressRoute | Function,
    ...middlewares: RouteMiddleware[] | ExpressRoute[] | Function[]
  ): Promise<void>;
  public async routesDirectory(
    path: string,
    arg1?: string | RouteMiddleware | ExpressRoute | Function | Route,
    ...args: RouteMiddleware[] | ExpressRoute[] | Function[]
  ): Promise<void> {
    const extensionsToSearch = ['.TS', '.JS'];
    const ignoreIfIncludes = ['.MAP.', '.SPEC.', '.TEST.'];

    const baseUrl = typeof arg1 === 'string' ? arg1 : this.baseUrl;

    const middlewares =
      typeof arg1 !== 'string' && arg1 !== undefined && !(arg1 instanceof Route)
        ? [arg1, ...args]
        : args;

    const files = readdirSync(path);

    const route =
      arg1 instanceof Route
        ? arg1
        : this.createRoute({ hidden: true, baseUrl, path: '' });

    if (middlewares.length) {
      const [arg1, ...args] = middlewares;
      route.use(arg1, ...args);
    }

    for await (const fileName of files) {
      const fileNameToUpperCase = fileName.toLocaleUpperCase();

      const hasAValidExtension = ignoreIfIncludes.map((text) =>
        fileNameToUpperCase.includes(text)
      );

      const haveAValidName = extensionsToSearch.map((ext) =>
        fileNameToUpperCase.endsWith(ext)
      );

      if (haveAValidName && hasAValidExtension) {
        const filePath = resolve(path, fileName);
        const setup = (await import(filePath)).default;

        if (typeof setup !== 'function') continue;

        setup(route);
      }
    }

    this.loadRoutes();
  }

  public route(options: { path?: string; baseUrl?: string }): Route;
  public route(path?: string, baseUrl?: string): Route;
  public route(
    arg1?: string | { path?: string; baseUrl?: string },
    arg2?: string
  ) {
    const { path, baseUrl } =
      typeof arg1 === 'object' ? arg1 : { path: arg1, baseUrl: arg2 };

    const route = this.getRoute(path, baseUrl);

    if (route) return route;

    return this.createRoute({ path, baseUrl });
  }

  private createRoute(options: {
    path?: string;
    baseUrl?: string;
    hidden?: boolean;
  }): Route;
  private createRoute(path?: string, baseUrl?: string, hidden?: boolean): Route;
  private createRoute(
    arg1?: string | { path?: string; baseUrl?: string; hidden?: boolean },
    arg2?: string,
    arg3?: boolean
  ) {
    const { path, baseUrl, hidden } =
      typeof arg1 === 'object'
        ? arg1
        : { path: arg1, baseUrl: arg2, hidden: arg3 };

    const router = Router();
    this.routers = [
      ...this.routers,
      { path, baseUrl, router, loaded: false, hidden: hidden || false }
    ];

    return new Route(router, this.adaptMiddlewares.bind(this));
  }

  public getRoute(path?: string, baseUrl?: string) {
    const route = this.routers.find(
      (route) =>
        route.path === path && route.baseUrl === baseUrl && !route.hidden
    );

    if (!route) return undefined;

    return new Route(route.router, this.adaptMiddlewares.bind(this));
  }

  private loadRoutes() {
    this.routers
      .filter((router) => !router.loaded)
      .forEach((router) => {
        const baseUrl = router.baseUrl ?? this.baseUrl;
        const path = router.path ?? '';
        const url = `${baseUrl}/${path}`.replaceAll(/\/{2,}/g, '/');
        this.express.use(url, router.router);
        router.loaded = true;
      });
  }

  private makeSetStateInRequest(request: Request) {
    return <T>(state: T) => {
      for (const key in state) {
        if (typeof key === 'string' || typeof key === 'number')
          request[SHARED_STATE_SYMBOL][key] = state[key];
      }
    };
  }

  private makeSharedStateInitializer() {
    return (request: Request, response: Response, next: NextFunction) => {
      request[SHARED_STATE_SYMBOL] = {};
      next();
    };
  }

  private makeSharedStateChanger<T>(state: T) {
    return (request: Request, _: Response, next: NextFunction) => {
      request[SHARED_STATE_SYMBOL] = state;
      next();
    };
  }

  public adapter(middleware: Middleware | Controller) {
    return this.middlewareAdapter(middleware);
  }

  private adaptMiddlewares(middlewares: RouteMiddleware[]) {
    return middlewares.map((middleware) => {
      if (typeof middleware === 'function')
        return (request: Request, response: Response, next: NextFunction) => {
          const middlewareResponse = middleware(request, response, next, [
            request[SHARED_STATE_SYMBOL],
            this.makeSetStateInRequest(request)
          ]);

          return middlewareResponse;
        };
      return this.middlewareAdapter(middleware);
    });
  }

  private middlewareAdapter(middleware: Middleware | Controller) {
    return async (request: Request, response: Response, next: NextFunction) => {
      request.body = convertSnakeCaseKeysToCamelCase(request.body);
      request.params = convertSnakeCaseKeysToCamelCase(request.params);
      request.query = convertSnakeCaseKeysToCamelCase(request.query);

      const httpResponse = await middleware.handle(
        request,
        [request[SHARED_STATE_SYMBOL], this.makeSetStateInRequest(request)],
        next
      );

      if (!httpResponse) return;

      if (httpResponse?.headers) response.set(httpResponse.headers);

      return response
        .status(httpResponse?.statusCode)
        .json(convertCamelCaseKeysToSnakeCase(httpResponse?.body));
    };
  }
}
