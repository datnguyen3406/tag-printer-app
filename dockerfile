FROM node:18-alpine

# Cài đặt Python3 và OpenCV cho Alpine để phục vụ nhận diện AI Barcode
RUN apk add --no-cache python3 py3-opencv

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]