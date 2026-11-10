function getUser(id) {
  return { id, name: "user" + id };
}

console.log(getUser(1));
