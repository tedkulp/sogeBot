FROM node

WORKDIR /app

COPY package.json package.json

RUN npm install

COPY . /app

RUN make bot ui

EXPOSE 20000

CMD npm run start
